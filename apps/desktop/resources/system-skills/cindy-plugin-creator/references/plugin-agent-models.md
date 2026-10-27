## 4.0.3a 只读 Agent 模型目录

设置页、panel、mainView 和电子脑均可 GET 同源 `/agent-models`。无参时返回本机已连接且可用于新任务的模型，并追加 `locations:[{agentDeviceId,name}]`（同账号其他电脑与生效中的供应商分享，不含本机；读不到位置时省略该字段）。可选查询参数只有 `agent_device_id`：带上后只投影那台位置允许远程调用的来源，响应回显 `agentDeviceId`。同一模型在不同来源下是多项。
返回 `{ok:true,models:[{id,name,agent,providerId,providerName,efforts,defaultEffort,visible}],agentDeviceId?,locations?}`。
无参时 visible 跟随当前账号模型选择器；带参时 visible 用模型目录默认值，不套本机开关。建议默认显示可见项，隐藏项由用户展开。旧 Host 缺这些字段时兼容原列表。
每项为独立的模型×框架×来源；空 efforts 与 null defaultEffort 表示未声明，不得猜测。
不代表远程 SSH 目录。读取不调用模型、不触发凭证认领或上游发现，不返回凭证、账号 identity 或 endpoint；不需要新增 manifest 权限。
格式非法、重复参数或其他查询参数返回 400。格式合法但那台离线、未知或没开远程控制时返回 503 且 `errorCode` 为 `NOT_AVAILABLE`，响应里没有本机条目。旧 Host 带任何参数都返回 400。旧 Host 可能返回 404，插件应明确提示升级；503 时提供重试。运行前再次核验选定来源。
