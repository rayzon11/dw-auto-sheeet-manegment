package com.b2c.hisab

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject

/** Fires on every inbound SMS. Pushes it to the server immediately. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val arr = JSONArray()
        for (m in msgs) {
            arr.put(JSONObject()
                .put("sender", m.originatingAddress ?: "")
                .put("body", m.displayMessageBody ?: "")
                .put("ts", java.util.Date(m.timestampMillis).toInstant().toString())
                .put("source", "sms"))
        }
        val payload = JSONObject().put("messages", arr)
        // Fire-and-forget: network call on background thread
        Thread {
            try { ApiClient.post(context, "/api/ingest/sms", payload) } catch (_: Exception) {}
        }.start()
    }
}
