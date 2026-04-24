package com.b2c.hisab

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object ApiClient {
    fun post(context: Context, path: String, body: JSONObject): String {
        val prefs = context.getSharedPreferences("hisab", Context.MODE_PRIVATE)
        val url = (prefs.getString("url", "") ?: "").trimEnd('/') + path
        val token = prefs.getString("token", "") ?: ""
        if (url.isBlank() || token.isBlank()) throw IllegalStateException("url/token not configured")

        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.connectTimeout = 10_000
        conn.readTimeout = 20_000
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val resp = stream?.bufferedReader()?.use { it.readText() } ?: ""
        return "HTTP $code: $resp"
    }
}
