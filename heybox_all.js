/*
小黑盒 - 全量每日任务整合与微信统一推送
账号环境变量:
  heybox_ck=pkey=xxx;x_xhh_tokenid=xxx;
*/
const { $, tools, Cache, notify } = require("./src/core");
const {
  DATA_NAME,
  HeyboxAccount,
  HeyboxAppClient,
  HeyboxWebClient,
} = require("./src/heybox");

const signModule = require("./heybox_sign");
const claimModule = require("./heybox_claim");
const rollModule = require("./heybox_roll");

exports.name = "小黑盒.每日全量与微信推送";

async function run() {
  if (!await $.read_env(HeyboxAccount, DATA_NAME)) return;

  Cache.cleanExpired("heybox_sign");
  Cache.cleanExpired("heybox_claim");
  Cache.cleanExpired("heybox_roll");

  // 初始化 App 版本 runtime
  const runtime = { version: "", build: "" };
  try {
    const bootClient = new HeyboxAppClient($.userList[0], { runtime });
    const boot = await bootClient.requestHkey("/task/list_v2/");
    runtime.version = boot.version;
    runtime.build = boot.build;
  } catch (e) {
    runtime.version = "1.3.393";
    runtime.build = "1119";
  }
  $.log(`当前版本: ${runtime.version} build=${runtime.build}`);

  // 发现 0元抽奖活动
  let rollAwards = [];
  try {
    const discoveryClient = new HeyboxWebClient($.userList[0]);
    rollAwards = await rollModule.discoverAwardIds(discoveryClient);
  } catch (e) {
    $.log(`抽奖活动检索失败: ${e.message}`);
  }

  let okCount = 0;
  const summaryList = [];

  for (const account of $.userList) {
    $.log(`\n=================== 开始执行账号 [${account.heyboxId}] ===================`);
    
    // 1. 执行每日签到与分享任务
    let signRes = null;
    try {
      signRes = await signModule.runAccount(account, runtime);
    } catch (e) {
      account.log(`签到任务失败: ${e.message}`);
    }

    await tools.sleep(1500);

    // 2. 执行普通领券
    let claimRes = { claimedCount: 0, skippedCount: 0 };
    try {
      claimRes = await claimModule.runAccount(account) || claimRes;
    } catch (e) {
      account.log(`领券任务失败: ${e.message}`);
    }

    await tools.sleep(1500);

    // 3. 执行0元抽奖盒券
    let rollRes = { runCount: 0, skipCount: 0, doneCount: 0, total: 0 };
    try {
      if (rollAwards.length) {
        rollRes = await rollModule.runAccount(account, rollAwards) || rollRes;
      }
    } catch (e) {
      account.log(`抽奖任务失败: ${e.message}`);
    }

    // 校验整体账号状态
    const isOk = signRes && signRes.ok;
    if (isOk) okCount += 1;

    const nickname = signRes?.nickname || account.heyboxId;
    const coin = signRes?.coin || "-";
    const coinValue = signRes?.coinValue || "-";
    const level = signRes?.level || "-";
    const currentExp = signRes?.currentExp;
    const nextLevelExp = signRes?.nextLevelExp;
    const expText = currentExp && nextLevelExp ? ` (${currentExp}/${nextLevelExp})` : "";
    const battery = signRes?.battery || "-";

    const accountReport = [
      `👤 账号【${nickname}】`,
      `📅 签到与分享: ${isOk ? "✅ 全部完成" : "⚠️ 部分未完成"}`,
      `🎫 优惠券领取: 已新增 ${claimRes.claimedCount || 0} 张 (自动跳过 ${claimRes.skippedCount || 0} 张)`,
      `🎁 抽奖盒券: 参与完成 ${rollRes.doneCount || 0}/${rollRes.total || rollAwards.length} 个活动`,
      `💰 盒币余额: ${coin} (≈${coinValue}￥)`,
      `🌟 当前等级: Lv.${level}${expText}`,
      `⚡ 当前盒电: ${battery}`,
    ].join("\n");

    summaryList.push(accountReport);
  }

  $.log(`\n=================== 执行完毕 (成功 ${okCount}/${$.userList.length}) ===================`);

  // 发送微信 / 多渠道消息推送
  const title = `小黑盒每日任务总统计 (${okCount}/${$.userList.length})`;
  const content = summaryList.join("\n\n------------------------------\n\n");
  await notify.sendNotify(title, content);

  process.exitCode = okCount === $.userList.length ? 0 : 1;
}

exports.run = run;

if (require.main === module) $.start(exports);
