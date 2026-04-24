package com.b2c.hisab

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Telephony
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Runs every 15 minutes. Re-scans SMS inbox since the last watermark and pushes
 * any new messages to the server. Server dedupes via ext_ref, so re-posting is safe.
 *
 * Why: real-time SMS receiver can miss messages when the phone is in deep sleep,
 * carrier delays arrive late, or the OS kills the process. Periodic backfill
 * closes that gap — nothing is ever lost as long as the SMS exists in the inbox.
 */
class BackfillWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        if (applicationContext.checkSelfPermission(Manifest.permission.READ_SMS)
            != PackageManager.PERMISSION_GRANTED) return Result.success()

        val prefs = applicationContext.getSharedPreferences("hisab", Context.MODE_PRIVATE)
        val since = prefs.getLong("last_backfill_ts", System.currentTimeMillis() - 24 * 3600_000L)

        val cursor = applicationContext.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
            "${Telephony.Sms.DATE} > ?",
            arrayOf(since.toString()),
            "${Telephony.Sms.DATE} ASC"
        )

        val arr = JSONArray()
        var maxTs = since
        cursor?.use {
            while (it.moveToNext()) {
                val ts = it.getLong(2)
                if (ts > maxTs) maxTs = ts
                arr.put(JSONObject()
                    .put("sender", it.getString(0) ?: "")
                    .put("body", it.getString(1) ?: "")
                    .put("ts", java.util.Date(ts).toInstant().toString())
                    .put("source", "backfill"))
            }
        }

        if (arr.length() == 0) return Result.success()
        return try {
            ApiClient.post(applicationContext, "/api/ingest/sms", JSONObject().put("messages", arr))
            prefs.edit().putLong("last_backfill_ts", maxTs).apply()
            Result.success()
        } catch (_: Exception) {
            Result.retry()  // WorkManager will exponentially back off
        }
    }

    companion object {
        private const val NAME = "hisab-backfill"
        fun enqueue(ctx: Context) {
            val work = PeriodicWorkRequestBuilder<BackfillWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                NAME, ExistingPeriodicWorkPolicy.KEEP, work)
        }
    }
}
