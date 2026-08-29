#!/bin/bash
# =============================================================
#  「好好睡觉」Qwen3-TTS 一键部署脚本（AutoDL 实例终端里运行）
#
#  用法（只需一行）：
#    cd /root && (cd countursheep 2>/dev/null && git pull -q || \
#      git clone -q https://github.com/babibabiya/countursheep.git) && \
#      cd countursheep && bash deploy_tts.sh
#
#  自动完成：体检 → 装依赖 → 停旧服务 → 下载模型 → 启动 → 自检
#  可重复运行（实例每次开机后跑一遍即可恢复服务）
# =============================================================

PORT="${PORT:-6006}"   # AutoDL「自定义服务」映射到外网 8443 的端口
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-sk-069baa049ed24bb2972699d84184ac13}"

say() { echo -e "\n\033[1;36m【$1】\033[0m"; }
ok()  { echo -e "  \033[1;32m✅ $1\033[0m"; }
bad() { echo -e "  \033[1;31m❌ $1\033[0m"; }

[ -f qwen_tts_server.py ] || { bad "当前目录没有 qwen_tts_server.py，请先 cd 到 countursheep 目录再运行"; exit 1; }

say "第 1/5 步：体检"
command -v python3 >/dev/null 2>&1 || { bad "没找到 python3"; exit 1; }
if nvidia-smi >/dev/null 2>&1; then
  ok "GPU 正常：$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)"
else
  bad "没检测到 GPU！这个模型需要 GPU，请去 AutoDL 换成 GPU 实例再跑"
  exit 1
fi

say "第 2/5 步：安装依赖（约 1~3 分钟）"
if pip install -q fastapi uvicorn qwen-tts soundfile requests; then
  ok "依赖装好了"
else
  bad "安装失败。先粘贴这行开启加速，再重新运行本脚本："
  echo "     source /etc/network_turbo"
  exit 1
fi

say "第 3/5 步：叫醒模型（首次需下载约 4GB，3~15 分钟；之后约 1 分钟）"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"   # 国内镜像加速
[ -d /root/autodl-tmp ] && export HF_HOME=/root/autodl-tmp/hf # 大文件放数据盘

# 停旧服务：先清掉占端口/同名旧进程
pkill -f qwen_tts_server.py 2>/dev/null
(fuser -k "${PORT}/tcp" 2>/dev/null || lsof -t -i:"${PORT}" 2>/dev/null | xargs kill -9 2>/dev/null); true
sleep 2

# 后台启动
nohup env PORT="$PORT" DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  python3 qwen_tts_server.py > tts.log 2>&1 &
echo $! > tts.pid
ok "服务已在后台启动，日志写在 tts.log"

say "第 4/5 步：等它穿衣服（首次最多等 15 分钟）"
i=0
while [ "$i" -lt 90 ]; do
  sleep 10; i=$((i+1))
  if curl -s "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"model_loaded": *true'; then
    ok "模型已就绪（共等了 $((i*10)) 秒）"
    break
  fi
  [ $((i % 6)) -eq 0 ] && echo "  ...还在加载/下载，别慌，已等 $((i*10)) 秒"
done

say "第 5/5 步：自检"
if curl -s "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"model_loaded": *true'; then
  ok "部署成功！🎉"
  ok "刷新你的网站点播放，就是 Qwen3-TTS 自然语音了"
  echo
  echo "  健康检查（浏览器打开）：https://u1147881-c7kl-35a69bfe.bjb1.seetacloud.com:8443/health"
  echo "  实例重启后服务会停：重新跑一遍本脚本即可（模型已缓存，约 1 分钟恢复）"
else
  bad "还没就绪。把下面命令的输出复制发给我："
  echo "     tail -50 tts.log"
  echo
  echo "  （若只是下载没下完，再跑一次本脚本会自动续上）"
  echo "  最近日志："
  tail -10 tts.log 2>/dev/null
fi
