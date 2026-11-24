package com.nathan.liftketo

import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.samsung.android.sdk.health.data.HealthDataService
import com.samsung.android.sdk.health.data.HealthDataStore
import com.samsung.android.sdk.health.data.data.HealthDataPoint
import com.samsung.android.sdk.health.data.error.HealthDataException
import com.samsung.android.sdk.health.data.error.ResolvablePlatformException
import com.samsung.android.sdk.health.data.permission.AccessType
import com.samsung.android.sdk.health.data.permission.Permission
import com.samsung.android.sdk.health.data.request.DataType
import com.samsung.android.sdk.health.data.request.DataTypes
import com.samsung.android.sdk.health.data.request.LocalTimeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Water logged on the Galaxy Watch or in Samsung Health. Samsung Health doesn't share water with
 * Health Connect, so this reads it straight from Samsung Health with Samsung's own Health Data SDK.
 * The app isn't a registered Samsung partner, so it only works with Samsung Health's
 * "Developer Mode for Data Read" turned on (Samsung Health > About > tap the version 10 times).
 */
@CapacitorPlugin(name = "SamsungWater")
class SamsungWaterPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val perms: Set<Permission> by lazy { setOf(Permission.of(DataTypes.WATER_INTAKE, AccessType.READ)) }

    private fun store(): HealthDataStore = HealthDataService.getStore(context.applicationContext)
    private fun supported() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    private fun fail(call: PluginCall, e: Throwable) {
        val code = (e as? HealthDataException)?.errorCode
        val msg = (e as? HealthDataException)?.errorMessage ?: e.message ?: e.javaClass.simpleName
        // Samsung Health missing, too old or not set up: Samsung can show its own fix-it screen
        if (e is ResolvablePlatformException && e.hasResolution) { try { activity?.let { e.resolve(it) } } catch (_: Exception) {} }
        call.resolve(JSObject().put("ok", false).put("code", code ?: -1).put("error", msg).put("kind", e.javaClass.simpleName))
    }

    @PluginMethod
    fun checkPermission(call: PluginCall) {
        if (!supported()) { call.resolve(JSObject().put("ok", false).put("error", "Needs Android 10 or newer")); return }
        scope.launch {
            try { call.resolve(JSObject().put("ok", true).put("granted", store().getGrantedPermissions(perms).containsAll(perms))) }
            catch (e: Throwable) { fail(call, e) }
        }
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (!supported()) { call.resolve(JSObject().put("ok", false).put("error", "Needs Android 10 or newer")); return }
        val act = activity ?: run { call.resolve(JSObject().put("ok", false).put("error", "No screen to ask on")); return }
        scope.launch {
            try {
                val s = store()
                val granted = if (s.getGrantedPermissions(perms).containsAll(perms)) perms else s.requestPermissions(perms, act)
                call.resolve(JSObject().put("ok", true).put("granted", granted.containsAll(perms)))
            } catch (e: Throwable) { fail(call, e) }
        }
    }

    /** startDate / endDate as ISO instants. Returns {ok, records:[{t (epoch seconds), ml, app}]}. */
    @PluginMethod
    fun read(call: PluginCall) {
        if (!supported()) { call.resolve(JSObject().put("ok", false).put("error", "Needs Android 10 or newer")); return }
        val start = call.getString("startDate"); val end = call.getString("endDate")
        if (start == null || end == null) { call.reject("startDate and endDate are required"); return }
        scope.launch {
            try {
                val zone = ZoneId.systemDefault()
                val filter = LocalTimeFilter.of(LocalDateTime.ofInstant(Instant.parse(start), zone), LocalDateTime.ofInstant(Instant.parse(end), zone))
                val s = store()
                val out = JSArray()
                var token: String? = null
                var pages = 0
                do {
                    val b = DataTypes.WATER_INTAKE.readDataRequestBuilder.setLocalTimeFilter(filter).setPageSize(500)
                    if (token != null) b.setPageToken(token)
                    val resp = s.readData(b.build())
                    for (p: HealthDataPoint in resp.dataList) {
                        val ml = p.getValue(DataType.WaterIntakeType.AMOUNT) ?: continue
                        out.put(JSObject().put("t", p.startTime.epochSecond).put("ml", ml.toDouble()).put("app", p.dataSource?.appId ?: ""))
                    }
                    token = resp.pageToken
                    pages++
                } while (!token.isNullOrEmpty() && pages < 20)
                call.resolve(JSObject().put("ok", true).put("records", out))
            } catch (e: Throwable) { fail(call, e) }
        }
    }
}
