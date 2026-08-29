#!/bin/bash
# =============================================================
#  「好好睡觉」Qwen3-TTS 一键部署脚本（AutoDL 实例终端里运行）
#
#  用法（只需一行）：
#    cd /root && (cd countursheep 2>/dev/null && git pull -q || \
#      git clone -q https://github.com/babibabiya/countursheep.git) && \
#      cd countursheep && bash deploy_tts.sh
#
#  自动完成：体检 → 装依赖 → 清端口(内核级/proc) → 启动 → 失败自动重试 → 自检
#  可重复运行（实例每次开机后跑一遍即可恢复服务）
# =============================================================

PORT="${PORT:-6006}"   # AutoDL「自定义服务」映射到外网 8443 的端口
# 密钥不进代码库：优先环境变量，其次 /root/.dskey 文件（密钥写进该文件即可）
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-$(cat /root/.dskey 2>/dev/null || true)}"

say() { echo -e "\n\033[1;36m【$1】\033[0m"; }
ok()  { echo -e "  \033[1;32m✅ $1\033[0m"; }
bad() { echo -e "  \033[1;31m❌ $1\033[0m"; }

[ -f qwen_tts_server.py ] || { bad "当前目录没有 qwen_tts_server.py，请先 cd 到 countursheep 目录再运行"; exit 1; }

# ---------- 内核级端口清理：直接读 /proc 找出占端口的进程（不依赖 fuser/lsof/ss） ----------
kill_port_holders() {
  pkill -f qwen_tts_server.py 2>/dev/null
  PORT="$PORT" python3 - <<'PYEOF'
import os, glob, sys
port = int(os.environ.get('PORT', '6006'))
ph = '%04X' % port
inos = set()
for fn in ('/proc/net/tcp', '/proc/net/tcp6'):
    try:
        lines = open(fn).read().splitlines()
    except OSError:
        continue
    for ln in lines[1:]:
        p = ln.split()
        if len(p) > 9 and p[3] == '0A' and p[1].endswith(':' + ph):
            inos.add(p[9])
found = {}
for fd in glob.glob('/proc/[0-9]*/fd/*'):
    try:
        t = os.readlink(fd)
    except OSError:
        continue
    if t.startswith('socket:[') and t[8:-1] in inos:
        pid = int(fd.split('/')[2])
        if pid == os.getpid():
            continue
        try:
            cmd = open('/proc/%d/cmdline' % pid).read().replace('\x00', ' ').strip()
        except OSError:
            cmd = '(读不到命令)'
        found[pid] = cmd
if not found:
    print('  端口 %d 干净，没有旧进程' % port)
for pid, cmd in sorted(found.items()):
    if ('python' in cmd) or ('uvicorn' in cmd) or ('tts' in cmd.lower()):
        print('  清掉旧进程 %d: %s' % (pid, cmd[:90]))
        try:
            os.kill(pid, 9)
        except OSError as e:
            print('    杀不掉: %s' % e)
    else:
        print('  !! 发现非 python 进程占着 %d（先不动它）: pid=%d cmd=%s' % (port, pid, cmd[:110]))
        print('     把上面这行发给 AI 助手')
PYEOF
}

say "第 1/5 步：体检"
command -v python3 >/dev/null 2>&1 || { bad "没找到 python3"; exit 1; }
if nvidia-smi >/dev/null 2>&1; then
  ok "GPU 正常：$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)"
else
  bad "没检测到 GPU！这个模型需要 GPU，请去 AutoDL 换成 GPU 实例再跑"
  exit 1
fi
# 顺手留存一份进程快照，出问题时发给 AI 助手定位用
{ echo "=== ps aux ==="; ps aux; echo "=== ss -tlnp ==="; ss -tlnp 2>/dev/null; } > /root/diag.txt 2>&1

say "第 2/5 步：安装依赖（约 1~3 分钟）"
if pip install -q fastapi uvicorn qwen-tts soundfile requests; then
  ok "依赖装好了"
else
  bad "安装失败。先粘贴这行开启加速，再重新运行本脚本："
  echo "     source /etc/network_turbo"
  exit 1
fi

say "第 3/5 步：清理旧服务（内核级，不依赖外部工具）"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"   # 国内镜像加速
[ -d /root/autodl-tmp ] && export HF_HOME=/root/autodl-tmp/hf # 大文件放数据盘
kill_port_holders
sleep 2

say "第 4/5 步：启动（端口被抢会自动清场重试，最多 3 次）"
started_ok=0
for attempt in 1 2 3; do
  nohup env PORT="$PORT" DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
    python3 qwen_tts_server.py > tts.log 2>&1 &
  echo $! > tts.pid
  [ "$attempt" -gt 1 ] || ok "服务已在后台启动，日志写在 tts.log"
  i=0
  while [ "$i" -lt 90 ]; do
    sleep 10; i=$((i+1))
    if curl -s "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"model_loaded": *true'; then
      started_ok=1; break
    fi
    if grep -q "address already in use" tts.log 2>/dev/null; then break; fi
    if ! kill -0 "$(cat tts.pid 2>/dev/null)" 2>/dev/null; then break; fi
    [ $((i % 6)) -eq 0 ] && echo "  ...还在加载/下载，别慌，已等 $((i*10)) 秒"
  done
  [ "$started_ok" -eq 1 ] && break
  if grep -q "address already in use" tts.log 2>/dev/null; then
    echo "  端口被别的进程抢占，自动清理后重试（第 ${attempt} 次）..."
    kill_port_holders
    sleep 2
  else
    echo "  进程异常退出，最近日志："
    tail -8 tts.log 2>/dev/null
    break
  fi
done

say "第 5/5 步：自检"
if [ "$started_ok" -eq 1 ]; then
  ok "部署成功！🎉"
  ok "刷新你的网站点播放，就是 Qwen3-TTS 自然语音了"
  echo
  echo "  健康检查（浏览器打开）：https://u1147881-c7kl-35a69bfe.bjb1.seetacloud.com:8443/health"
  echo "  实例重启后服务会停：重新跑一遍本脚本即可（模型已缓存，约 1 分钟恢复）"
else
  bad "还没就绪。把下面两个文件的内容发给 AI 助手："
  echo "     tail -50 tts.log"
  echo "     cat /root/diag.txt"
  echo
  echo "  最近日志："
  tail -10 tts.log 2>/dev/null
fi
