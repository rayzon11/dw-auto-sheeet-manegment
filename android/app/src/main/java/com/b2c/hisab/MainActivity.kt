package com.b2c.hisab

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.provider.Telephony
import android.widget.*
import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("hisab", Context.MODE_PRIVATE)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 60, 40, 40)
        }

        val tvTitle = TextView(this).apply { text = "B2C Hisab — SMS Sync"; textSize = 20f }
        val urlEt = EditText(this).apply {
            hint = "Server URL (e.g. http://192.168.1.10:3000)"
            setText(prefs.getString("url", ""))
        }
        val tokEt = EditText(this).apply {
            hint = "API token (from web app Admin tab)"
            setText(prefs.getString("token", ""))
        }
        val saveBtn = Button(this).apply { text = "Save config" }
        val permBtn = Button(this).apply { text = "Grant SMS permissions" }
        val notifBtn = Button(this).apply { text = "Grant Notification access" }
        val backfillBtn = Button(this).apply { text = "Backfill: send last 500 SMS" }
        statusView = TextView(this).apply { text = "Status: idle" }

        saveBtn.setOnClickListener {
            prefs.edit()
                .putString("url", urlEt.text.toString().trim())
                .putString("token", tokEt.text.toString().trim())
                .apply()
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        }
        permBtn.setOnClickListener {
            if (Build.VERSION.SDK_INT >= 23) {
                requestPermissions(arrayOf(
                    Manifest.permission.READ_SMS,
                    Manifest.permission.RECEIVE_SMS,
                    Manifest.permission.POST_NOTIFICATIONS,
                ), 1)
            }
        }
        notifBtn.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        backfillBtn.setOnClickListener { doBackfill() }

        listOf(tvTitle, urlEt, tokEt, saveBtn, permBtn, notifBtn, backfillBtn, statusView).forEach {
            root.addView(it, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 20 })
        }
        setContentView(root)

        // Kick off the periodic backfill (idempotent — KEEP policy)
        BackfillWorker.enqueue(applicationContext)
    }

    private fun doBackfill() {
        statusView.text = "Status: reading SMS…"
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "Grant SMS permission first", Toast.LENGTH_LONG).show(); return
        }
        val cursor = contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
            null, null, Telephony.Sms.DATE + " DESC LIMIT 500"
        )
        val arr = JSONArray()
        cursor?.use {
            while (it.moveToNext()) {
                val obj = JSONObject()
                    .put("sender", it.getString(0) ?: "")
                    .put("body", it.getString(1) ?: "")
                    .put("ts", java.util.Date(it.getLong(2)).toInstant().toString())
                arr.put(obj)
            }
        }
        val payload = JSONObject().put("messages", arr)
        Thread {
            try {
                val r = ApiClient.post(this, "/api/ingest/sms", payload)
                runOnUiThread { statusView.text = "Backfill result:\n$r" }
            } catch (e: Exception) {
                runOnUiThread { statusView.text = "Error: ${e.message}" }
            }
        }.start()
    }
}
