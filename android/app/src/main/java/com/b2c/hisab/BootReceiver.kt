package com.b2c.hisab

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Kept so the SmsReceiver is re-bound after reboot. No active work needed — receivers
 *  declared in the manifest auto-revive once the package is unfrozen. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            BackfillWorker.enqueue(context)
        }
    }
}
