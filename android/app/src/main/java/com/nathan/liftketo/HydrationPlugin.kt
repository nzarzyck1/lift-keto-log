package com.nathan.liftketo

import android.content.Intent
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Instant

/** Reads water (hydration) records from Health Connect, which Samsung Health syncs into. */
@CapacitorPlugin(name = "Hydration")
class HydrationPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val perm = HealthPermission.getReadPermission(HydrationRecord::class)

    private fun client(): HealthConnectClient? =
        if (HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(context) else null

    private fun answerGranted(call: PluginCall) {
        val c = client()
        if (c == null) { call.resolve(JSObject().put("available", false).put("granted", false)); return }
        scope.launch {
            try {
                val granted = c.permissionController.getGrantedPermissions()
                call.resolve(JSObject().put("available", true).put("granted", granted.contains(perm)))
            } catch (e: Exception) { call.reject(e.message ?: "permission check failed") }
        }
    }

    @PluginMethod
    fun checkPermission(call: PluginCall) = answerGranted(call)

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (client() == null) { call.resolve(JSObject().put("available", false).put("granted", false)); return }
        val intent: Intent = PermissionController.createRequestPermissionResultContract().createIntent(context, setOf(perm))
        startActivityForResult(call, intent, "onPermissionResult")
    }

    @ActivityCallback
    private fun onPermissionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        answerGranted(call)
    }

    /** startDate / endDate as ISO instants. Returns every hydration record in range. */
    @PluginMethod
    fun readRecords(call: PluginCall) {
        val c = client() ?: run { call.reject("Health Connect isn't available"); return }
        val start = call.getString("startDate"); val end = call.getString("endDate")
        if (start == null || end == null) { call.reject("startDate and endDate are required"); return }
        scope.launch {
            try {
                val out = JSArray()
                var token: String? = null
                do {
                    val resp = c.readRecords(ReadRecordsRequest(HydrationRecord::class, TimeRangeFilter.between(Instant.parse(start), Instant.parse(end)), pageToken = token))
                    for (r in resp.records) {
                        out.put(JSObject()
                            .put("startDate", r.startTime.toString())
                            .put("endDate", r.endTime.toString())
                            .put("liters", r.volume.inLiters)
                            .put("sourceBundleId", r.metadata.dataOrigin.packageName))
                    }
                    token = resp.pageToken
                } while (!token.isNullOrEmpty())
                call.resolve(JSObject().put("records", out))
            } catch (e: Exception) { call.reject(e.message ?: "couldn't read water") }
        }
    }
}
