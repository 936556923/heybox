/*
小黑盒 - 每日任务
账号环境变量:
  heybox_ck=pkey=xxx;x_xhh_tokenid=xxx;
*/
const crypto = require("crypto");
const { $, tools, HttpClient } = require("./src/core");
const {
  API_BASE,
  APP_UA,
  APP_REFERER,
  DATA_BASE,
  DATA_NAME,
  HeyboxAccount,
  HeyboxAppClient,
  OK_STATE,
  PATH_DATA_REPORT,
  sendShareEvents,
} = require("./src/heybox");
const { buildQueryString } = require("./src/heybox/signature");

exports.name = "小黑盒.每日任务";

const WAITING_STATE = "waiting";
const FINISH_STATE = "finish";

const PATH_LIST = "/task/list_v2/";
const PATH_SIGN = "/task/sign_v3/sign";
const PATH_STATE = "/task/sign_v3/get_sign_state";

const SHARE_TASK_SETTLE_MS = 2200;
const SHARE_VERIFY_RETRIES = 3;
const SHARE_VERIFY_INTERVAL_MS = 1200;

// 参考 wqe134/xiaoheihe-autosign 的任务 hkey 服务器
const TASK_HKEY_API = "http://47.120.39.109:9900/hkey";

// 通过标题正则匹配分享类任务
const SHARE_TASK_ACTIONS = Object.freeze([
  {
    taskName: "shareArticle",
    titlePattern: /分享.*(帖子|贴子|文章)|分享任意帖子/,
  },
  {
    taskName: "shareGameDetail",
    titlePattern: /分享.*(游戏详情)|前往.*(游戏详情)/,
  },
  {
    taskName: "shareGameComment",
    titlePattern: /分享.*(游戏评价|评论)|发表.*(游戏评价)/,
  },
]);

function isOkPayload(payload) {
  return tools.toText(payload?.status) === OK_STATE;
}

function extractTaskList(payload) {
  const result = payload && typeof payload.result === "object" ? payload.result : {};
  const user = result && typeof result.user === "object" ? result.user : {};
  const levelInfo = user && typeof user.level_info === "object" ? user.level_info : {};
  const groups = Array.isArray(result.task_list) ? result.task_list : [];

  const tasks = [];
  for (const group of groups) {
    const groupTitle = tools.toText(group?.title);
    const list = Array.isArray(group?.tasks) ? group.tasks : [];
    for (const item of list) {
      const reportExtra = item?.report_extra && typeof item.report_extra === "object" ? item.report_extra : {};
      const awardText = (Array.isArray(item?.award_desc_v2) ? item.award_desc_v2 : [])
        .map((award) => {
          const desc = tools.toText(award.desc);
          const icon = tools.toText(award.icon);
          if (icon.includes("b9aca51c")) return `${desc}H币`;
          if (icon.includes("c10d89ae")) return `${desc}经验`;
          if (icon.includes("e63b192a")) return `${desc}盒电`;
          return desc;
        })
        .filter(Boolean)
        .join(" ");
      tasks.push({
        groupTitle,
        title: tools.toText(item?.title),
        state: tools.toText(item?.state),
        stateDesc: tools.toText(item?.state_desc),
        taskId: tools.toText(reportExtra.task_id),
        taskType: tools.toText(item?.type),
        reportTaskType: tools.toText(reportExtra.task_type),
        maxjia: tools.toText(item?.maxjia),
        awardText,
      });
    }
  }

  return {
    nickname: tools.toText(user.username),
    coin: tools.toText(levelInfo.coin),
    level: tools.toText(levelInfo.level),
    battery: tools.toText(user.battery),
    tasks,
  };
}

function taskKey(task) {
  return `${task.taskId}|${task.title}`;
}

function findTaskByKey(snapshot, key) {
  return snapshot.tasks.find((task) => taskKey(task) === key);
}

function isSignTask(task) {
  return task.taskType === "sign";
}

function isDailyTask(task) {
  return isSignTask(task) || task.reportTaskType === "daily";
}

function matchShareAction(task) {
  for (const action of SHARE_TASK_ACTIONS) {
    if (action.titlePattern.test(task.title)) {
      return action;
    }
  }
  return null;
}

function isShareTask(task) {
  return matchShareAction(task) !== null;
}

async function settleShareTask(task, fetchSnapshotFn, detail) {
  await tools.sleep(SHARE_TASK_SETTLE_MS);
  const snapshot = await fetchSnapshotFn();
  const after = findTaskByKey(snapshot, taskKey(task));
  if (after && after.state === FINISH_STATE) {
    return { ok: true, message: `${task.title} 完成${detail ? ` ${detail}` : ""}`, snapshot };
  }
  return { ok: false, message: `${task.title} 未完成` };
}

async function executeSign(client) {
  const signResp = await client.getJson(PATH_SIGN);
  const firstState = tools.toText(signResp?.result?.state);
  if (firstState === "ignore") return { ok: true, message: "今日已签到" };
  await tools.sleep(800);
  const finalPayload = await client.getJson(PATH_STATE);
  const status = tools.toText(finalPayload.status);
  const result = finalPayload?.result || {};
  const state = tools.toText(result.state);
  if ((status === OK_STATE && state === OK_STATE) || state === "ignore") {
    const parts = [];
    if (result.sign_in_coin) parts.push(`+${result.sign_in_coin}H币`);
    if (result.sign_in_exp) parts.push(`+${result.sign_in_exp}经验`);
    if (result.sign_in_streak) parts.push(`连签${result.sign_in_streak}天`);
    return { ok: true, message: parts.length ? parts.join(" ") : "签到完成" };
  }
  return { ok: false, message: tools.toText(finalPayload.msg) || state || "签到失败" };
}

// ========== 分享任务：通过 hkey 任务服务器执行 ==========
// 参考 wqe134/xiaoheihe-autosign 的实现方式
// 由服务端根据 taskName 自动生成加密数据提交到 data_report

const taskHttpClient = new HttpClient({ timeoutMs: 5000 });

async function getTaskHkey(heyboxId, taskName) {
  const resp = await taskHttpClient.post({
    url: TASK_HKEY_API,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      heyboxId,
      type: 5,
      taskName,
    }),
  });
  return resp.result;
}

async function executeShareByServer(task, client, fetchSnapshotFn) {
  const action = matchShareAction(task);
  if (!action) {
    return { ok: false, unsupported: true, message: `${task.title} 未匹配到分享任务模式` };
  }

  // 方式1：优先尝试原生加密上报 (sendShareEvents)
  try {
    const shareSourceMap = {
      shareArticle: "link",
      shareGameDetail: "game_detail",
      shareGameComment: "game_comment",
    };
    const source = shareSourceMap[action.taskName] || "link";
    await sendShareEvents(client, source, {});
  } catch (err) {
    // 忽略异常，继续备用方式
  }

  // 方式2：备用远程 task hkey 上报
  try {
    const hkeyInfo = await getTaskHkey(client.account.heyboxId, action.taskName);
    if (hkeyInfo && hkeyInfo.hkey) {
      const version = hkeyInfo.version || "1.3.347";
      const build = hkeyInfo.build || "916";
      const queryParams = client.buildSignedQuery(PATH_DATA_REPORT, {
        hkey: hkeyInfo.hkey,
        version: version,
        build: build,
        time: hkeyInfo.timestamp,
      }, {
        type: "104",
        time_: hkeyInfo.timestamp,
        session_id: crypto.randomUUID(),
      });
      const query = buildQueryString(queryParams);
      const body = buildQueryString({
        data: hkeyInfo.data,
        key: hkeyInfo.key,
        sid: hkeyInfo.sid,
      });

      await client.post({
        url: `${DATA_BASE}${PATH_DATA_REPORT}?${query}`,
        headers: {
          "User-Agent": APP_UA,
          Referer: APP_REFERER,
          Cookie: client.account.appCookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    }
  } catch (err) {
    // 忽略备用方式异常
  }

  // 多次重试验证任务状态
  for (let retry = 0; retry < SHARE_VERIFY_RETRIES; retry += 1) {
    await tools.sleep(SHARE_VERIFY_INTERVAL_MS);
    const snapshot = await fetchSnapshotFn();
    const after = findTaskByKey(snapshot, taskKey(task));
    if (after && after.state === FINISH_STATE) {
      return { ok: true, message: `${task.title} 完成 (${action.taskName})`, snapshot };
    }
  }
  return { ok: false, message: `${task.title} 未确认完成 (${action.taskName})` };
}

// ========== time_limit 任务：发布内容 ==========
const POST_TITLE = "前面忘了中间忘了后面也忘了";
const POST_CONTENT = "孩子很爱用，很好吃，会复购";

const PATH_BBS_POST = "/bbs/app/api/link/post";
const PATH_BBS_DELETE = "/bbs/app/link/delete";

async function executeTimeLimitTask(task, client, fetchSnapshotFn) {
  // topic_id 在 maxjia 字段中，格式: heybox://{URL编码的JSON}
  let topicId = null;
  if (task.maxjia) {
    try {
      const jsonStr = decodeURIComponent(task.maxjia.replace(/^heybox:\/\//, ""));
      const parsed = JSON.parse(jsonStr);
      topicId = parsed.params?.topic_id;
    } catch (e) {
      // 解析失败
    }
  }

  if (!topicId) {
    return { ok: false, unsupported: true, message: `${task.title} 缺少 topic_id` };
  }

  const text = JSON.stringify([{ checked: false, text: POST_CONTENT, type: "text" }]);

  // 使用 postJson 发送明文 form-urlencoded 数据
  const postData = {
    draft: "0",
    topic_ids: String(topicId),
    link_tag: "27",
    text: text,
    title: POST_TITLE,
    desc: POST_CONTENT,
  };

  const resp = await client.postJson(
    PATH_BBS_POST,
    {},
    postData,
    { baseUrl: API_BASE },
  );

  if (resp.status === OK_STATE && resp.result && resp.result.link_id) {
    const linkId = resp.result.link_id;
    tools.log(`发帖成功: link_id=${linkId}`);

    // 等待任务结算
    await tools.sleep(3000);

    // 删除帖子
    tools.log(`正在删除帖子 ${linkId}...`);
    const delResp = await client.postJson(PATH_BBS_DELETE, {}, { link_id: String(linkId) }, { baseUrl: API_BASE });
    if (delResp.status === OK_STATE) {
      tools.log(`帖子已删除`);
    } else {
      tools.log(`删除失败: ${delResp.msg || "未知错误"}`);
    }

    await tools.sleep(SHARE_TASK_SETTLE_MS);
    const snapshot = await fetchSnapshotFn();
    const after = findTaskByKey(snapshot, taskKey(task));
    if (after && after.state === FINISH_STATE) {
      return { ok: true, message: `${task.title} 完成`, snapshot };
    }
    return { ok: false, message: `发帖成功(link_id=${linkId})但任务未完成` };
  }

  return { ok: false, message: `发帖失败: ${resp.msg || resp.status}` };
}

const TASK_HANDLERS = {
  "33": executeTimeLimitTask,
};

function isPostContentTask(task) {
  return task.taskId === "33" || /发布.*(内容|帖子)|发帖/.test(task.title);
}

async function executeTask(task, client, fetchSnapshotFn) {
  // 签到任务
  if (isSignTask(task)) {
    try {
      return await executeSign(client);
    } catch (error) {
      return { ok: false, message: `${task.title} 请求异常 ${error.message}` };
    }
  }

  // 分享类任务：通过标题正则匹配，使用 hkey 任务服务器执行
  if (isShareTask(task)) {
    try {
      return await executeShareByServer(task, client, fetchSnapshotFn);
    } catch (error) {
      return { ok: false, message: `${task.title} 请求异常 ${error.message}` };
    }
  }

  // 社区发帖任务：自动进行【发帖 -> 自动删帖 -> 结算】
  if (isPostContentTask(task)) {
    try {
      return await executeTimeLimitTask(task, client, fetchSnapshotFn);
    } catch (error) {
      return { ok: false, message: `${task.title} 请求异常 ${error.message}` };
    }
  }

  // 其他任务：通过 task_id 匹配处理器
  const handler = TASK_HANDLERS[task.taskId];
  if (!handler) return { ok: false, unsupported: true, message: `未支持任务 task_id=${task.taskId} ${task.title}` };
  try {
    return await handler(task, client, fetchSnapshotFn);
  } catch (error) {
    return { ok: false, message: `${task.title} 请求异常 ${error.message}` };
  }
}

async function fetchSnapshot(client) {
  const raw = await client.getJson(PATH_LIST);
  const snapshot = extractTaskList(raw);
  snapshot.status = tools.toText(raw?.status);
  snapshot.msg = tools.toText(raw?.msg);
  return snapshot;
}

async function runAccount(account, runtime) {
  account.log("开始每日任务");
  const client = new HeyboxAppClient(account, { runtime });
  let snapshot = await fetchSnapshot(client);
  if (snapshot.status === "relogin" || snapshot.msg === "请重新登录") {
    account.log("账号凭证已失效或过期，请重新登录小黑盒并抓取最新 Cookie (pkey 和 x_xhh_tokenid)");
    return { ok: false, doneCount: 0 };
  }

  account.log(`账号=${snapshot.nickname || account.heyboxId} 黑盒ID=${account.heyboxId} IMEI=${account.imei}`);

  const unsupported = new Set();
  const done = new Set();
  // 支持所有已实现的任务类型（每日任务 + time_limit 任务）
  const allTasks = snapshot.tasks.filter(
    (task) => isDailyTask(task) || isShareTask(task) || isPostContentTask(task) || TASK_HANDLERS[task.taskId],
  );
  for (const task of allTasks) {
    if (task.state === FINISH_STATE) {
      done.add(task.title || taskKey(task));
      const award = task.awardText ? ` (${task.awardText})` : "";
      account.log(`${task.title}: 已完成${award}`);
    }
  }

  for (const task of allTasks.filter((item) => item.state === WAITING_STATE)) {
    const key = taskKey(task);
    snapshot = await fetchSnapshot(client);
    const latestTask = findTaskByKey(snapshot, key);
    if (!latestTask || latestTask.state !== WAITING_STATE) continue;

    const result = await executeTask(latestTask, client, () => fetchSnapshot(client));
    if (result.unsupported) {
      unsupported.add(latestTask.title || key);
      continue;
    }

    snapshot = result.snapshot || await fetchSnapshot(client);
    const after = findTaskByKey(snapshot, key);
    if (after && after.state === FINISH_STATE) {
      done.add(after.title || key);
      const award = latestTask.awardText ? ` 奖励: ${latestTask.awardText}` : "";
      const extra = result.message ? ` (${result.message})` : "";
      account.log(`${after.title}: 已完成${award}${extra}`);
    } else {
      account.log(`${latestTask.title}: 未完成，${result.message}`);
    }
  }

  snapshot = await fetchSnapshot(client);
  const coinValue = Number.isFinite(Number(snapshot.coin)) ? Number(snapshot.coin) / 1000 : "未知";
  account.log(`当前盒币: ${snapshot.coin || "未知"} ≈ ${coinValue}￥`);
  account.log(`当前等级: ${snapshot.level || "未知"}`);
  account.log(`当前盒电: ${snapshot.battery || "未知"}`);
  if (unsupported.size) account.log(`未支持任务: ${Array.from(unsupported).join(" | ")}`);
  const waiting = snapshot.tasks.filter((task) => isDailyTask(task) && task.state === WAITING_STATE);
  return { ok: waiting.length === 0, doneCount: done.size };
}

async function run() {
  if (!await $.read_env(HeyboxAccount, DATA_NAME)) return;

  const runtime = { version: "", build: "" };
  const bootClient = new HeyboxAppClient($.userList[0], { runtime });
  const boot = await bootClient.requestHkey(PATH_LIST);
  runtime.version = boot.version;
  runtime.build = boot.build;
  $.log(`当前版本: ${runtime.version} build=${runtime.build}`);

  let okCount = 0;
  for (const account of $.userList) {
    try {
      const result = await runAccount(account, runtime);
      if (result.ok) okCount += 1;
    } catch (error) {
      account.log(`任务执行失败: ${error.message}`);
    }
  }

  $.log(`\n完成: ${okCount}/${$.userList.length}`);
  process.exitCode = okCount === $.userList.length ? 0 : 1;
}

exports.run = run;

if (require.main === module) $.start(exports);
