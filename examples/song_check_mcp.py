# -*- coding: utf-8 -*-
"""song_check_mcp.py —— 给主持人用的查歌工具（一个很小的 MCP 服务）。

为什么要它：主持人（你的 AI）跑命令的那台机器，看不到电台这边网易云能不能放一首歌
（开放平台的曲库比 App 小，很多歌是 visible:false）。不查就点，常常是串场说的那首放不出来。
所以放歌之前先查：哪几首能放、哪首这几天刚放过，能放的顺带几条热评 —— 挑一首能放的再开口。
候选（[song:歌名|歌手；替补|歌手]）是查过之后的兜底。

它只做一件事：HTTP 调电台后端的 GET /api/radio/check，把结果翻成好读的一份。

装：pip install mcp
跑：python examples/song_check_mcp.py            （stdio，加进你的 AI 客户端的 MCP 配置里）
配：环境变量
    RADIO_BASE_URL   电台后端在哪（宿主服务的地址），默认 http://127.0.0.1:3000
    RADIO_TOKEN      宿主要的口令（放在 X-Radio-Token 请求头里）；没有就不带
已经有自己的 MCP 服务的话，import 这个文件，调 register(你的_mcp) 就行。
"""
import json
import os
import urllib.parse
import urllib.request

BASE = os.environ.get("RADIO_BASE_URL", "http://127.0.0.1:3000").rstrip("/")


def _radio_get(path, timeout=60):
    headers = {}
    tk = os.environ.get("RADIO_TOKEN", "")
    if tk:
        headers["X-Radio-Token"] = tk
    req = urllib.request.Request(BASE + path, method="GET", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def song_check(songs: str, hot: bool = True) -> str:
    """电台放歌之前先查：这几首在电台那边能不能放、这几天放没放过，能放的顺带几条热评（只读）。

    网易云有的歌电台那边放不了（没版权 / 要会员 / 数字专辑），你这边看不出来。
    写串场之前先查，挑一首能放、没放过的再开口 —— 串场说的就是真放的那首。

    ★ 用法：一次最多五首，「歌名|歌手」用分号隔开：
        song_check(songs="夜に駆ける|YOASOBI；Aqua|坂本龍一")
    ★ 回的每一首：
        能放 → 电台会放的那个版本（歌名 / 歌手）；「这几天放过」的别再点。
        放不了 → 网易云的说法（没版权 / 要会员 / 数字专辑 / 没搜到）。
        「这会儿查不了」= 网易云那边一时没回，不一定放不了。
    ★ 热评：能放、没放过的前两首会带几条（原话 + 点赞数）。念的时候说清是评论区里的，网名不念。
        没带热评（或者是空的）就不念评论，绝不编。
    ★ 写 [song:…] 时，第一首写你查过能放、串场说的那首，后面跟一两首能放的替补。

    Args:
        songs: 「歌名|歌手；歌名|歌手」，最多五首（歌手可以不写，但写了更准）
        hot:   要不要顺带翻热评，默认要
    """
    q = (songs or "").strip()
    if not q:
        return json.dumps({"error": "songs 是空的。写成 歌名|歌手；歌名|歌手"}, ensure_ascii=False, indent=2)
    try:
        d = _radio_get("/api/radio/check?songs=" + urllib.parse.quote(q[:600]) + ("" if hot else "&hot=0"))
    except Exception as e:
        return json.dumps({"error": "电台的查歌接口调不通：%s" % e,
                           "说明": "电台后端没起，或者 RADIO_BASE_URL 不对。这回就照旧写几首候选，电台会放第一首能放的"},
                          ensure_ascii=False, indent=2)
    out = []
    for s in d.get("songs") or []:
        if s.get("ok"):
            row = {"你问的": s.get("asked"), "能放": True, "电台会放": "%s — %s" % (s.get("title"), s.get("artist"))}
            if s.get("recent"):
                row["这几天放过"] = "七天里电台放过，别再点"
            if "hot" in s:
                row["热评"] = (["%s（%d 赞）" % (c.get("text"), int(c.get("likes") or 0)) for c in (s.get("hot") or [])]
                               or "这首没翻到热评 —— 别念评论")
        else:
            row = {"你问的": s.get("asked"), "能放": False, "为什么": s.get("why")}
        out.append(row)
    ok = [r for r in out if r.get("能放") and not r.get("这几天放过")]
    tip = ("能放、没放过的：" + "、".join(r["你问的"] for r in ok)) if ok else "这几首都不行 —— 换几首再查"
    return json.dumps({"结果": out, "提示": tip}, ensure_ascii=False, indent=2)


def register(mcp):
    """挂到一个已有的 FastMCP 服务上。"""
    mcp.tool()(song_check)


if __name__ == "__main__":
    from mcp.server.fastmcp import FastMCP
    server = FastMCP("midnight-fm")
    register(server)
    server.run()
