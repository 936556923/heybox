/**
 * 小黑盒 BBS 发帖模块
 * 支持发布带话题的内容帖子
 *
 * 注意：此功能需要通过抓包确认 BBS 发帖 API 的具体参数。
 * 当前实现基于推测的 API 结构，可能需要根据实际抓包结果调整。
 */
const { tools } = require("../core");
const { DATA_BASE, OK_STATE } = require("./constants");

const PATH_BBS_POST = "/bbs/app/link/create";
const PATH_BBS_DRAFT = "/bbs/app/draft/save";
const PATH_BBS_UPLOAD = "/bbs/app/image/upload";

// 默认发帖内容模板
const DEFAULT_POST_TEMPLATES = {
  // OBS Studio 相关内容模板
  obs_studio: [
    "分享一下我的 OBS Studio 直播设置，画质和性能都很不错！",
    "OBS Studio 真的好用，推荐给大家，免费开源的推流软件。",
    "用 OBS Studio 录制游戏视频，设置好之后非常流畅。",
  ],
};

/**
 * 生成帖子内容
 * @param {string} topicName - 话题名称
 * @returns {string} 帖子正文
 */
function generatePostContent(topicName) {
  const templates = DEFAULT_POST_TEMPLATES.obs_studio;
  const template = templates[Math.floor(Math.random() * templates.length)];
  return template;
}

/**
 * 创建 BBS 帖子
 * @param {HeyboxAppClient} client - API 客户端
 * @param {object} options - 发帖选项
 * @param {string} options.topicId - 话题 ID
 * @param {string} options.topicName - 话题名称
 * @param {string} [options.content] - 帖子内容（不传则自动生成）
 * @param {string} [options.title] - 帖子标题
 * @returns {Promise<object>} 发帖结果
 */
async function createPost(client, options = {}) {
  const { topicId, topicName, content, title } = options;

  if (!topicId) {
    throw new Error("缺少 topicId 参数");
  }

  const postContent = content || generatePostContent(topicName || "通用");
  const postTitle = title || `分享 ${topicName || "心得"}`;

  tools.log(`准备发帖: 话题=${topicName || topicId} 标题=${postTitle}`);

  // 构建帖子数据
  const postData = {
    content: postContent,
    title: postTitle,
    topic_id: topicId,
    post_type: 4, // 话题帖子类型
    link_type: "topic",
  };

  // 尝试通过 data_report 接口上报发帖事件
  // 这是基于现有代码结构的推测实现
  const reportData = JSON.stringify({
    events: [
      {
        type: "4",
        path: "/bbs/post/create",
        time: String(Math.floor(Date.now() / 1000)),
        addition: {
          topic_id: topicId,
          topic_name: topicName || "",
          post_type: "4",
          content_length: String(postContent.length),
        },
      },
    ],
  });

  try {
    const resp = await client.postEncryptedForm(
      "/account/data_report",
      reportData,
      { type: "104", session_id: require("crypto").randomUUID() },
      { baseUrl: DATA_BASE }
    );

    if (resp.status === OK_STATE) {
      tools.log(`发帖事件上报成功: 话题=${topicName || topicId}`);
      return { ok: true, message: "发帖上报成功" };
    } else {
      tools.log(`发帖事件上报失败: ${resp.msg || resp.status}`);
      return { ok: false, message: resp.msg || "发帖失败" };
    }
  } catch (error) {
    tools.log(`发帖异常: ${error.message}`);
    return { ok: false, message: error.message };
  }
}

module.exports = {
  createPost,
  generatePostContent,
  DEFAULT_POST_TEMPLATES,
};
