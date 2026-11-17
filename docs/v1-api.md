# V1 API 文档

接口使用同源会话 Cookie。JSON 修改请求使用 `Content-Type: application/json`。以下路径使用 `/api` 前缀。管理员没有默认读取老人测量的权限。

## 身份、家庭与档案

| 方法和路径 | 行为 |
| --- | --- |
| `POST /auth/register`、`POST /auth/login`、`POST /auth/logout` | 登录使用 `identifier` 和密码。注册支持本人或家属身份，会话由服务端管理。 |
| `GET /auth/me`、`GET/PUT /profile/me` | 查询当前身份和本人健康档案，保存本人资料。 |
| `GET /care/capabilities`、`GET /care/relationships` | 查看权限词典和授权关系。 |
| `POST /care/invitations` | 本人设置 `member_role`、`scopes`、`valid_days`。家属代录测量需显式勾选 `record_measurements`。 |
| `POST /care/accept` | 家属或医生提交一次性 `code`，服务器校验角色、有效期与使用状态。 |
| `PATCH /care/relationships/:id`、`POST /care/relationships/:id/revoke`、`GET /care/relationships/:id/logs` | 本人修改、撤回、查询授权审计。 |
| `GET /care/subjects`、`GET /care/seniors/:id/summary` | 按授权返回可见的老人、能力和摘要。 |
| `POST /prediction/intakes` | 填写或代填档案问卷。代填需 `record_intake`，服务器保存对象、操作者和角色。 |

## 测量与趋势

| 方法和路径 | 请求和结果 |
| --- | --- |
| `GET /health/metric-defs` | 返回服务端指标定义、单位、范围及计值类型。 |
| `GET /health/metrics` | 返回本人的各指标最新值，未记录项为 null。 |
| `POST /health/metrics` | 提交 `type`、`value`，血压带 `value2`。支持 `unit`、`recorded_at`、`measurement_condition`、`note`。家属代录带 `subject_user_id`，来源与操作者由服务器确定。成功沿用 HTTP 200。相同指标、值与条件且时间差小于 60 秒时返回 `duplicate: true`。家属只按本人之前的提交去重。 |
| `GET /health/metrics/:id` | 默认读取本人单条记录。医生授权含 `view_trends` 时可显式传 `subject_user_id`。 |
| `GET /health/metrics/:type/history?days=30` | 支持 1–365 天整数。返回时间排序的 `points`，以及按单位和测量条件分组的 `statistics`。每组包含原记录 ID 和两个数值通道的记录数、最小值、最大值、均值。委托读取需要 `view_trends`。 |
| `PATCH /health/metrics/:id` | 仅本人，提交最新 `revision` 和修正字段。指标类别、原始来源、记录归属、创建时间和原录入者由服务器维护。 |
| `DELETE /health/metrics/:id` | 仅本人，JSON 请求体携带最新 `revision`。返回 `{ok:true,id}`，原始测量从活跃数据表移除，审计保留元数据。引用该值的复测同步撤除或重新等待确认。 |
| `POST /health/metrics/parse-description` | 解析口述或文字输入，返回待核对字段。落库由用户另行保存。 |
| `POST /devices/:id/sync` | 同步本人设备。使用统一测量校验，服务器绑定设备并保存来源。 |
| `GET /health/summary`、`GET /trend/:type`、`GET /alerts` | 本人概览、单指标趋势、预警。 |
| `GET /health/alert-rules` | 返回测量提醒的阈值、版本、来源、适用范围，以及趋势提醒版本。 |

记录修改和删除遇到版本冲突返回 409。错误或单位不一致返回 400。授权不足返回 403，未指定他人对象且该记录不归本人时返回 404。已删除的测量不再出现在历史或实时趋势中。历史消息和已经保存的干预评价属于历史输出。

## 管家、计划与复测

| 方法和路径 | 行为 |
| --- | --- |
| `POST /chat` | 输入 `message`，可指定授权的 `subject_user_id` 和 `conversation_id`。输出 `content`、`confidence`、`evidence`、`tool_trace`、`llm`。调用失败时 `llm.call_status=fallback`，配有简明错误码。 |
| `GET /agent/inbox` | 显示授权范围内的复测、待确认行动和改善计划。 |
| `POST /actions/interventions` | 本人保存草案或待确认计划。给出标题、协议、目标指标、三个时间窗和依从率目标。 |
| `GET /actions/interventions`、`GET /actions/interventions/:id` | 按本人或授权对象查看。执行反馈需要查看执行情况的权限。 |
| `PATCH /actions/interventions/:id` | 本人修订未激活计划，提交 `revision` 和改动字段。草案回到 `proposed`，旧确认凭证失效。 |
| `POST /actions/interventions/:id/submit`、`POST /actions/interventions/:id/confirm` | 提交后取得 `confirmation.one_time_token`。本人另行确认，用 `confirmation_token` 提交。 |
| `POST /actions/interventions/:id/executions` | 记录已完成或未完成。提交 `performed` 和 `performed_at`，可附 `user_note`。未完成要填写 `skip_reason`。家属代录需要 `record_adherence`。 |
| `POST /actions`、`POST /actions/:id/confirm` | 提交复测等行动待确认预览，再用一次性凭证执行。 |
| `GET /actions/followups`、`POST /actions/followups/:id/candidate/confirm` | 查询复测记录，按授权确认候选测量。提交 `metric_id`。 |

工具由后端白名单和参数 Schema 约束。个人摘要、预警、趋势和复测工具使用对应权限。健康管理规则生成的提醒是站内信息。复测、待办等行动经过各自的确认接口。
