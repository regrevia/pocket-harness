package com.whale.pet

/**
 * 宿主和插件塞进会话里的内容：对模型有用，对看对话的人没有意义。
 *
 * 两类来源：一是宿主自己加的（时间戳、运行时上下文、压缩摘要、轮内调度提醒），
 * 二是旁挂插件（视觉辅助 IntelliF 之类）往会话里灌的观察块。后者以前会把一整段
 * `[视觉辅助观察 …] … [/视觉辅助观察]` 摆进 App 的对话记录里——这里统一认、统一挡。
 *
 * 原则：宁可漏挡一条插件块，也不要误杀主人自己的长回复。所以「看起来像系统提示」
 * 只在长度和多个特征词同时命中时才判定。
 */
object InjectedText {

    /** 开头就是这些的，整条都是注入（大小写不敏感）。 */
    private val prefixes = listOf(
        "Time sampled while preparing turn",
        "Current runtime context.",
        "<system-reminder>",
        "<available_skills>",
        "<available-skills>",
        "<environment_context>",
        "This is an automatically generated checkpoint",
        "The context was just compacted",
        "Fast mode reminder",
        "Auto schedule",
        "</compacted",
        "<compacted",
        "[checkpoint]",
    )

    /** 中文压缩摘要的小节标题（标题头被宿主吃掉时只剩它们）。 */
    private val summaryHeads = listOf(
        "## 主要请求与意图",
        "## 主要请求和意图",
        "## 关键上下文",
        "## 当前工作",
        "## 待办",
        "## 下一步",
        "## 已完成",
        "## 主要请求",
    )

    /** 开头就是一对尖括号标签（`<goal_round>`、`<turn>`、`</turn>`）。 */
    private val leadingTag = Regex("^\\s*</?[A-Za-z][\\w-]*\\s*[>/]")

    private val bulletPath = Regex("(?m)^[-*]\\s*`")
    private val summaryTag = Regex("</?compacted[-_ ]?summary>", RegexOption.IGNORE_CASE)

    /* ---------------- 插件观察块（视觉辅助 / IntelliF） ---------------- */

    /** 插件标记的几种写法：中文标记，以及英文插件名（大小写不敏感）。 */
    private const val PLUGIN_NAME = "(?:视觉辅助观察|IntelliF|intellif)"
    private val pluginMarker = Regex(PLUGIN_NAME, RegexOption.IGNORE_CASE)

    /** `[视觉辅助观察 …] … [/视觉辅助观察]`：成对的一整块（跨行）。 */
    private val pluginPair = Regex(
        "\\[\\s*$PLUGIN_NAME[^\\]]*\\][\\s\\S]*?\\[\\s*/\\s*$PLUGIN_NAME[^\\]]*\\]",
        RegexOption.IGNORE_CASE,
    )

    /** `<dsh-intellif> … </dsh-intellif>` 这种标签形态的整块。 */
    private val pluginTagPair = Regex(
        "<\\s*[\\w-]*$PLUGIN_NAME[\\w-]*[^>]*>[\\s\\S]*?<\\s*/\\s*[\\w-]*$PLUGIN_NAME[\\w-]*\\s*>",
        RegexOption.IGNORE_CASE,
    )

    /** 单个括号块：`[视觉辅助观察 …]`、`【视觉辅助观察…】`、`[IntelliF …]`。 */
    private val pluginBracket = Regex(
        "[\\[【]\\s*/?\\s*$PLUGIN_NAME[^\\]】]*[\\]】]",
        RegexOption.IGNORE_CASE,
    )

    /** 整行只有个残缺的块标题（没有闭合括号、正文被切走了）。 */
    private val pluginHeading = Regex(
        "(?m)^[\\s#>*·\\-]*[\\[【]?\\s*$PLUGIN_NAME[^，。！？；\\n]{0,40}[\\]】]?\\s*$",
        RegexOption.IGNORE_CASE,
    )

    /** `IntelliF: 图片请求无响应，…` 这种「插件名 + 冒号 + 一行说明」的提示行。 */
    private val pluginNotice = Regex(
        "(?m)^[\\s>#*·\\-]*(?:IntelliF|视觉辅助观察)\\s*[:：][^\\n]*",
        RegexOption.IGNORE_CASE,
    )

    /** 去掉正文开头的 markdown 装饰后再认标记。 */
    private val headDecor = Regex("^[\\s#>*·\\-—]+")

    /** 看起来像插件系统提示的开头：整条都是提示词，不是人说的话。 */
    private val strongPromptHeads = listOf(
        "# 角色",
        "# Role",
        "You are a",
        "You are an",
        "系统提示：",
        "系统提示:",
        "## 视觉辅助观察",
        "【视觉辅助观察",
        "[视觉辅助观察",
        "[/视觉辅助观察",
    )

    /** 系统提示里成堆出现的特征词：单看一个不算，几百字里同时出现两个以上才算整段 dump。 */
    private val promptWords = listOf(
        "# 角色",
        "# Role",
        "You are",
        "系统提示",
        "工具调用",
        "tool_call",
        "tool_calls",
        "工具定义",
        "<available_tools>",
        "## 输入",
        "## 输出",
    )

    /*
     * 视觉辅助插件的观察块认出来就整块切掉；它跟正常正文混在同一条里时，
     * 只去掉块本身，正文照常上屏。
     */
    /**
     * 后台任务回执：宿主把「命令跑完了」当成一条助手消息写进转录
     * （`background job bash-… finished …`、`(bash: …, exit code: 0). Read its output with job_output.`）。
     * 桌面上它是可折叠的过程行，手机上第 3 行规定不渲染——这里统一认出来。
     */
    fun isProcessNotice(text: CharSequence?): Boolean {
        if (text == null) return false
        val raw = text.trim()
        if (raw.isEmpty()) return false
        // 后台任务回执常常把整段命令一起带进来（上千字），不能按长度一刀切：认开头
        val jobHead = raw.startsWith("background job ") || raw.startsWith("job ")
        if (jobHead) {
            // 回执有三种：还在跑、跑完、被中断。三种都是过程行
            return raw.contains("exit code") || raw.contains("finished [status:") ||
                raw.contains("completed [status:") || raw.contains("job_output") ||
                raw.contains("running;")
        }
        if (raw.length > 600) return false
        if (raw.startsWith("(bash:") || raw.startsWith("bash:")) {
            return raw.contains("exit code") || raw.contains("job_output")
        }
        return raw.contains("Read its output with job_output") && raw.contains("exit code")
    }

    fun stripPluginBlocks(text: CharSequence?): String {
        val raw = text?.toString().orEmpty()
        if (raw.isEmpty() || !pluginMarker.containsMatchIn(raw)) return raw.trim()
        var out = pluginTagPair.replace(raw, "")
        out = pluginPair.replace(out, "")
        out = pluginBracket.replace(out, "")
        out = pluginHeading.replace(out, "")
        out = pluginNotice.replace(out, "")
        return out.trim()
    }

    fun isInjected(text: CharSequence?): Boolean {
        val body = text?.toString()?.trim().orEmpty()
        if (body.isEmpty()) return true
        if (prefixes.any { body.startsWith(it, ignoreCase = true) }) return true
        if (summaryHeads.any { body.contains(it) }) return true
        if (summaryTag.containsMatchIn(body)) return true
        // 运行时上下文常以 `<goal_round>`、`<turn>` 这类标签开头，正文里不会这么写
        if (leadingTag.containsMatchIn(body)) return true
        // 整条就是一块插件观察：剥完什么都不剩，就不摆出来
        if (pluginMarker.containsMatchIn(body) && stripPluginBlocks(body).isEmpty()) return true
        if (looksLikePluginDump(body)) return true
        return looksLikeSummaryDump(body)
    }

    /** 视觉辅助那类插件的系统提示：正文够长、且同时带着好几个系统提示的特征词。 */
    private fun looksLikePluginDump(body: String): Boolean {
        val head = body.replace(headDecor, "")
        if (strongPromptHeads.any { head.startsWith(it, ignoreCase = true) }) return true
        if (body.length < 300) return false
        return promptWords.count { body.contains(it, ignoreCase = true) } >= 2
    }

    /** 压缩摘要被切成碎块时只剩一串「- `/绝对路径` — 做了什么」。 */
    private fun looksLikeSummaryDump(body: String): Boolean {
        if (body.length < 600) return false
        return bulletPath.findAll(body).count() >= 4
    }
}
