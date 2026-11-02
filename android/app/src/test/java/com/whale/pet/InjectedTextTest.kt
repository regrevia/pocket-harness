package com.whale.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 转录过滤的回归用例。
 *
 * 手机端只摆「人说的话」：工具执行行、后台任务回执、运行时注入（`<goal_round>` 之类）、
 * 插件观察块都不上屏。这些判断是纯函数，宿主不在线也能验。
 */
class InjectedTextTest {

    @Test
    fun `后台任务回执不上屏`() {
        val running = "background job bash-1234 running; read its output with job_output"
        assertTrue(InjectedText.isProcessNotice(running))

        val done = "background job bash-6d9edfd5 completed [status: exit code: 0]"
        assertTrue(InjectedText.isProcessNotice(done))

        val longCommand = "background job bash-4b6af2e7 completed [status: exit code: 0]\n" +
            "cd /Users/apple/Desktop/work/Pet && python3 - <<'PY'\n" + "x".repeat(2000)
        assertTrue(InjectedText.isProcessNotice(longCommand))

        val bashTail = "(bash: node scripts/a.mjs, exit code: 0). Read its output with job_output."
        assertTrue(InjectedText.isProcessNotice(bashTail))
    }

    @Test
    fun `正常对话不会被当成过程行`() {
        assertFalse(InjectedText.isProcessNotice(null))
        assertFalse(InjectedText.isProcessNotice(""))
        assertFalse(InjectedText.isProcessNotice("我把构建修好了，接着跑真机验收。"))
        assertFalse(InjectedText.isProcessNotice("exit code 0 是什么意思？"))
        assertFalse(InjectedText.isProcessNotice("今天先不重启宿主。"))
    }

    @Test
    fun `运行时注入的上下文不上屏`() {
        assertTrue(InjectedText.isInjected("<goal_round>3/40</goal_round>"))
        assertTrue(InjectedText.isInjected("<system-reminder>context compacted</system-reminder>"))
        assertFalse(InjectedText.isInjected("这段话里提到 <goal_round> 也不算注入吗"))
    }

    @Test
    fun `插件观察块整块切掉`() {
        val withBlock = "<dsh-intellif>\n视觉辅助的观察内容\n</dsh-intellif>\n真正的回复"
        val stripped = InjectedText.stripPluginBlocks(withBlock)
        assertFalse(stripped.contains("视觉辅助的观察内容"))
        assertTrue(stripped.contains("真正的回复"))

        assertEquals("普通一句话", InjectedText.stripPluginBlocks("普通一句话"))
    }
}
