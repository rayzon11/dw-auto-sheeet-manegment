package com.b2c.hisab

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/** Catches bank-app push notifications (for banks that notify via push, not SMS). */
class BankNotifListener : NotificationListenerService() {

    // Only relay notifications from bank apps we care about (package-name allowlist).
    private val bankPkgs = setOf(
        "com.snapwork.hdfc", "com.csam.icici.bank.imobile", "com.axis.mobile",
        "com.sbi.SBIFreedomPlus", "com.sbi.lotusintouch",
        "com.msf.kbank.mobile", "com.infrasofttech.indianBank",
        "com.fss.pnbpsp", "com.bankofbaroda.mconnect", "com.canarabank.mobility",
        "com.unionbank.ecommerce.mobile.commercial", "com.idfcFirstBank.Mobile.Banking",
        "com.rbl.bank", "com.yes.mobile", "com.kotak.mobile",
        "com.dcb.dcbbnk", "com.sbm.onlineFD", "org.ideabank.yono.sbi",
        "com.google.android.apps.nbu.paisa.user", // GPay
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in bankPkgs) return
        val extras = sbn.notification.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text  = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
                 ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: ""
        if (text.isBlank()) return
        val body = if (title.isNotBlank()) "$title — $text" else text

        val payload = JSONObject().put("messages", JSONArray().put(
            JSONObject()
                .put("sender", sbn.packageName)
                .put("body", body)
                .put("ts", java.util.Date(sbn.postTime).toInstant().toString())
                .put("source", "notif")
        ))
        Thread {
            try { ApiClient.post(applicationContext, "/api/ingest/sms", payload) } catch (_: Exception) {}
        }.start()
    }
}
