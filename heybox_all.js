/*
小黑盒 - 全量每日任务整合与微信统一精细化推送
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

function formatNumber(num) {
  if (num === null || num === undefined || num === "-") return "-";
  const n = Number(num);
  return Number.isFinite(n) ? n.toLocaleString() : String(num);
}

function getTaskIcon(title) {
  if (/签到/.test(title)) return "📝";
  if (/帖子|贴子|文章/.test(title)) return "📢";
  if (/游戏详情/.test(title)) return "🎮";
  if (/游戏评价|评论/.test(title)) return "💬";
  if (/发布|发帖|内容/.test(title)) return "✍️";
  return "📌";
}

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
  const nowTime = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

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
    const coinStr = (signRes?.coin && signRes.coin !== "") ? signRes.coin : "-";
    const coinValueStr = (signRes?.coinValue && signRes.coinValue !== "" && signRes.coinValue !== "未知") ? signRes.coinValue : null;
    const levelStr = (signRes?.level && signRes.level !== "") ? signRes.level : "-";
    const currentExp = signRes?.currentExp;
    const nextLevelExp = signRes?.nextLevelExp;
    const batteryStr = (signRes?.battery && signRes.battery !== "") ? signRes.battery : "-";

    const expText = currentExp && nextLevelExp ? `${formatNumber(currentExp)} / ${formatNumber(nextLevelExp)} EXP` : "暂无";
    const expDiff = currentExp && nextLevelExp ? Number(nextLevelExp) - Number(currentExp) : 0;
    const expDiffText = expDiff > 0 ? ` (距升级还差 ${formatNumber(expDiff)} EXP)` : "";

    const taskLines = [];
    const taskList = Array.isArray(signRes?.taskList) ? signRes.taskList : [];
    if (taskList.length) {
      for (const t of taskList) {
        const icon = getTaskIcon(t.title);
        const status = t.isFinished ? "✅ 已完成" : "⚠️ 未完成";
        const award = t.award ? ` (${t.award})` : "";
        taskLines.push(`- ${icon} **${t.title}**：${status}${award}`);
      }
    } else {
      taskLines.push(`- 📌 **每日签到与分享任务**：${isOk ? "✅ 全部完成" : "⚠️ 未完成"}`);
    }
    const unsupportedTasks = Array.isArray(signRes?.unsupportedTasks) ? signRes.unsupportedTasks : [];
    if (unsupportedTasks.length) {
      taskLines.push(`- ⚠️ **以下任务暂不支持自动完成**：${unsupportedTasks.join("、")}`);
    }

    if (signRes?.isExpired) {
      const expiredReport = [
        `🚨 **账号凭证失效警示**  `,
        `👤 **账号 ID**：${account.heyboxId}  `,
        `📅 **检测时间**：${nowTime}  `,
        ``,
        `---`,
        `⚠️ **问题原因**：小黑盒 Cookie 登录凭证已过期或失效  `,
        `💡 **解决指引**：  `,
        `1. 打开手机 Stream 抓包软件`,
        `2. 打开小黑盒 App 刷新任意页面`,
        `3. 复制最新的 \`pkey\` 与 \`x_xhh_tokenid\``,
        `4. 更新到 GitHub 仓库 Secrets 的 \`HEYBOX_CK\` 变量中`,
      ].join("\n");
      summaryList.push(expiredReport);
      continue;
    }

    const accountReport = [
      `👤 **账号**：${nickname} (ID: ${account.heyboxId})  `,
      `📅 **运行时间**：${nowTime}  `,
      ``,
      `---`,
      `💰 **账户最新资产概览**`,
      `- 🪙 **盒币余额**：\`${formatNumber(coinStr)}\` 币${coinValueStr ? ` (约 **${coinValueStr}** 元)` : ""}`,
      `- 🌟 **账号等级**：**Lv.${levelStr}**${expText !== "暂无" ? ` \`(${expText})\`` : ""}${expDiffText}`,
      `- ⚡ **盒电余额**：\`${formatNumber(batteryStr)}\` ⚡`,
      ``,
      `---`,
      `📋 **每日任务完成明细**`,
      taskLines.join("\n"),
      ``,
      `---`,
      `🎁 **拓展福利与活动处理**`,
      `- 🎫 **优惠券领取**：新增 \`${claimRes.claimedCount || 0}\` 张 (自动跳过 \`${claimRes.skippedCount || 0}\` 张已领券)`,
      `- 🎲 **0元抽奖盒券**：${rollAwards.length
        ? `已尝试 \`${rollRes.runCount || 0}\` 个活动 (完成 \`${rollRes.doneCount || 0}/${rollRes.total || rollAwards.length}\`)`
        : "未发现进行中的抽奖活动"}`,
      ``,
      `---`,
      `🎉 **总体运行状态**：${isOk ? "✅ 每日任务 100% 成功完成！" : "⚠️ 存在部分任务未完成"}`,
    ].join("\n");

    summaryList.push(accountReport);
  }

  $.log(`\n=================== 执行完毕 (成功 ${okCount}/${$.userList.length}) ===================`);

  // 发送微信 / 多渠道精细化消息推送
  const title = `📢 小黑盒每日运行报告 (${okCount}/${$.userList.length})`;
  const content = summaryList.join("\n\n---\n\n");
  await notify.sendNotify(title, content);

  process.exitCode = okCount === $.userList.length ? 0 : 1;
}

exports.run = run;

if (require.main === module) $.start(exports);
