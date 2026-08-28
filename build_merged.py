#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把独立页面合并为一个单文件 HTML（外壳 + template + iframe srcdoc）。

- 各页面完整放入 <template>，样式/脚本互相隔离
- 顶层页面渲染进外壳 iframe（srcdoc），页面间跳转改写为内部路由
- localStorage 同源共享，行为与原版一致
"""
import os

BASE = os.path.dirname(os.path.abspath(__file__))
PAGES = ["index", "caignick", "sound", "read", "relax", "box"]
DEFAULT_PAGE = "index"

templates = []
titles = {}
for name in PAGES:
    with open(os.path.join(BASE, name + ".html"), encoding="utf-8") as f:
        html = f.read().strip()
    templates.append('<template id="tpl-%s">\n%s\n</template>' % (name, html))
    t = ""
    if "<title>" in html:
        t = html.split("<title>", 1)[1].split("</title>", 1)[0].strip()
    titles[name] = t

shell = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>好好睡觉</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #f6e8d4; }
#app-frame { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
</style>
</head>
<body>

__TEMPLATES__

<iframe id="app-frame" title="好好睡觉"></iframe>

<script>
(function() {
  'use strict';

  var PAGES = __PAGES__;
  var DEFAULT_PAGE = '__DEFAULT__';
  var TITLES = __TITLES__;

  var frame = document.getElementById('app-frame');
  var stack = [];

  function pageHtml(page) {
    var tpl = document.getElementById('tpl-' + page);
    if (!tpl) { page = DEFAULT_PAGE; tpl = document.getElementById('tpl-' + page); }
    return tpl.innerHTML;
  }

  // 顶层页面：跳转改写为外壳路由
  function transform(html) {
    return html
      .replace(/location\\.href\\s*=\\s*(['"])([^'"\\s]+?)\\.html\\1/g, "parent.nav('$2')")
      .replace(/location\\.href\\s*=\\s*map\\[name\\]/g, "parent.nav(map[name].replace(/\\\\.html$/,''))")
      .replace(/\\bhistory\\.back\\(\\)/g, 'parent.navBack()');
  }

  function render(page) {
    frame.srcdoc = transform(pageHtml(page));
    if (TITLES[page]) document.title = TITLES[page];
    try { history.replaceState(null, '', '#' + page); } catch (e) {}
  }

  window.nav = function(page) {
    page = String(page || '').replace(/\\.html$/, '');
    if (PAGES.indexOf(page) < 0) page = DEFAULT_PAGE;
    stack.push(page);
    render(page);
  };

  window.navBack = function() {
    stack.pop();
    var prev = stack.length ? stack[stack.length - 1] : DEFAULT_PAGE;
    if (stack.length === 0) stack.push(prev);
    render(prev);
  };

  var init = (location.hash || '').replace('#', '').replace(/\\.html$/, '');
  if (PAGES.indexOf(init) < 0) init = DEFAULT_PAGE;
  stack.push(init);
  render(init);
})();
</script>

</body>
</html>
"""

out = shell.replace("__TEMPLATES__", "\n\n".join(templates))
out = out.replace("__PAGES__", repr(PAGES).replace("'", '"'))
out = out.replace("__DEFAULT__", DEFAULT_PAGE)
out = out.replace("__TITLES__", repr(titles).replace("'", '"'))

target = os.path.join(BASE, "app.html")
with open(target, "w", encoding="utf-8") as f:
    f.write(out)
print("written:", target, os.path.getsize(target), "bytes")
