# V1 数据字典

## 核心测量指标

运行时的准确信息以 `GET /api/health/metric-defs` 返回的 `metric_defs` 为准。下表范围用于校验录入。临床与统计参考见预警规则。

| type | 含义 | 单位 | 可录入范围 | 测量条件 |
| --- | --- | --- | --- | --- |
| `bp` | 血压，`value` 为收缩压、`value2` 为舒张压 | mmHg | 50–250 / 30–180 | `morning_rest`、`evening_rest`、`other`、`unknown` |
| `glucose` | 血糖 | mmol/L | 1–33 | `fasting`、`postprandial_2h`、`random`、`unknown` |
| `hr` | 心率 | bpm | 20–220 | `resting`、`active`、`unknown` |
| `spo2` | 血氧饱和度 | % | 50–100 | `other`、`unknown` |
| `sleep` | 夜间睡眠时长 | h | 0–24 | `other`、`unknown` |
| `weight` | 体重 | kg | 20–200 | `morning_fasting`、`other`、`unknown` |
| `steps` | 日步数 | 步 | 0–100000 | `other`、`unknown` |

写入采用字典单位。只归一化同义单位，例如 bpm 与次/分。其他单位应在录入前换成字典单位。空条件记录为 `unknown`。历史空值保留原样。

## 数据表与字段

| 表或字段 | 含义 |
| --- | --- |
| `metrics.id`、`user_id` | 测量 ID、服务对象 ID。应用分配递增编号，删除后不重复分配。 |
| `metrics.type`、`value`、`value2`、`unit` | 指标类别、主值、次值、单位。非双值指标的次值为空。 |
| `metrics.recorded_at`、`created_at`、`updated_at` | 测量时间、创建时间、最近更新时间。新记录用 UTC ISO 8601，旧记录可能保留 SQLite 时间格式。 |
| `metrics.source` | `manual` 本人手工，`device` 登记设备，`caregiver_report` 家属代录，`synthetic` 测试或演示。 |
| `metrics.actor_user_id`、`device_id` | 录入者和所属设备登记 ID。旧记录可能为空，界面按缺数据处理。 |
| `metrics.measurement_condition`、`measurement_context` | 规范化测量条件及结构化附加上下文。 |
| `metrics.data_quality` | JSON，包含有效状态、单位校验后的质量、时间来源、是否有测量条件。旧记录可能没有质量标记。 |
| `metrics.revision` | 乐观并发版本，从 1 起。修正写入后递增。 |
| `metric_id_sequence`、`audit_logs` | 保留测量编号上界。审计事件 `health_measurement` 记录创建、更新、删除的主体、操作人和最少元数据。 |
| `users`、`care_relationships`、`care_access_logs` | 用户档案、授权范围及有效期、授权日志。 |
| `health_intakes`、`health_intake_answers` | 问卷、分项答案、对象、填写者和填写角色。 |
| `interventions`、`action_requests`、`intervention_execution_logs` | 草案及计划版本、一次性确认及关联对象、执行状态和反馈。 |
| `followups`、`discovery_events`、`alerts` | 复测、版本化规则事件、告警。新告警可关联源事件、指标 ID 和规则版本。 |

## 规则依据

- `elderly-discovery.2026-11.v1` 的血压提醒是家庭测量触发条件。产品在收缩压 ≥180 或舒张压 ≥120 时提示复测，等于阈值也触发是工程取法。适用范围参考非孕成人说明。[American Heart Association](https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings/when-to-call-911-for-high-blood-pressure)
- 血糖低于 3.9 mmol/L 触发提醒，低于 3.0 mmol/L 使用更高提醒级别。范围参考成人糖尿病低血糖分级，严重健康事件仍需按实际症状和医疗流程处理。[ADA Standards of Care 2026](https://diabetesjournals.org/care/article/49/Supplement_1/S132/163927/6-Glycemic-Goals-Hypoglycemia-and-Hyperglycemic)
- 血氧低于 90% 和体温达 39 °C 是项目设置的复测提醒值。血氧读数应考虑设备误差、个人基线和测量条件。资料中的临床就医条件和产品温度触发值有区别。[MedlinePlus 血氧测量](https://medlineplus.gov/lab-tests/pulse-oximetry/) · [MedlinePlus 发热](https://www.medlineplus.gov/ency/article/003090.htm)
- `health-trend-alert.2026-11.v1` 按 90 天窗口内的实测记录运行已有趋势引擎。异常波动、明显方向、可用预测区间触及参考范围是工程提示规则。相关记录 ID 和版本随新提醒保存。规则未作为临床诊断获批。
