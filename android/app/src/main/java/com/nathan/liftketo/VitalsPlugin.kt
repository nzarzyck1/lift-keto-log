package com.nathan.liftketo

import android.content.Intent
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
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
import kotlinx.coroutines.withContext
import java.time.Instant
import kotlin.reflect.KClass

/**
 * Reads the Galaxy Watch's body data from Health Connect (Samsung Health writes it there):
 * heart rate, resting heart rate, HRV, sleep with stages, workouts, calories, SpO2,
 * breathing rate, weight and body fat. Scores are worked out in app.html so they can
 * change without a new install; this only hands back compact raw data.
 */
@CapacitorPlugin(name = "Vitals")
class VitalsPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val types: Map<String, KClass<out Record>> = linkedMapOf(
        "hr" to HeartRateRecord::class,
        "rhr" to RestingHeartRateRecord::class,
        "hrv" to HeartRateVariabilityRmssdRecord::class,
        "sleep" to SleepSessionRecord::class,
        "exercise" to ExerciseSessionRecord::class,
        "active" to ActiveCaloriesBurnedRecord::class,
        "total" to TotalCaloriesBurnedRecord::class,
        "spo2" to OxygenSaturationRecord::class,
        "resp" to RespiratoryRateRecord::class,
        "weight" to WeightRecord::class,
        "fat" to BodyFatRecord::class,
    )
    private val history = "android.permission.health.READ_HEALTH_DATA_HISTORY"
    private val perms: Set<String> = types.values.map { HealthPermission.getReadPermission(it) }.toSet() + history

    private fun client(): HealthConnectClient? =
        if (HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(context) else null

    private fun answerGranted(call: PluginCall) {
        val c = client()
        if (c == null) { call.resolve(JSObject().put("available", false).put("granted", JSArray())); return }
        scope.launch {
            try {
                val granted = c.permissionController.getGrantedPermissions()
                val out = JSArray()
                for ((k, cls) in types) if (granted.contains(HealthPermission.getReadPermission(cls))) out.put(k)
                if (granted.contains(history)) out.put("history")
                call.resolve(JSObject().put("available", true).put("granted", out))
            } catch (e: Exception) { call.reject(e.message ?: "permission check failed") }
        }
    }

    @PluginMethod
    fun checkPermission(call: PluginCall) = answerGranted(call)

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (client() == null) { call.resolve(JSObject().put("available", false).put("granted", JSArray())); return }
        val intent: Intent = PermissionController.createRequestPermissionResultContract().createIntent(context, perms)
        startActivityForResult(call, intent, "onPermissionResult")
    }

    @ActivityCallback
    private fun onPermissionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        answerGranted(call)
    }

    private suspend fun <T : Record> readAll(c: HealthConnectClient, cls: KClass<T>, range: TimeRangeFilter): List<T> {
        val out = ArrayList<T>()
        var token: String? = null
        do {
            val resp = c.readRecords(ReadRecordsRequest(cls, range, pageSize = 2000, pageToken = token))
            out.addAll(resp.records)
            token = resp.pageToken
        } while (!token.isNullOrEmpty())
        return out
    }

    private fun sec(i: Instant) = i.epochSecond

    /**
     * startDate / endDate as ISO instants. Heart rate comes back as one average per minute
     * ([epochSecond, bpm] pairs); everything else as small arrays. A type that isn't allowed
     * or fails is listed in "errors" and the rest still come back.
     */
    @PluginMethod
    fun read(call: PluginCall) {
        val c = client() ?: run { call.reject("Health Connect isn't available"); return }
        val start = call.getString("startDate"); val end = call.getString("endDate")
        if (start == null || end == null) { call.reject("startDate and endDate are required"); return }
        scope.launch {
            try {
                val out = withContext(Dispatchers.Default) {
                    val range = TimeRangeFilter.between(Instant.parse(start), Instant.parse(end))
                    val granted = c.permissionController.getGrantedPermissions()
                    val res = JSObject()
                    val errors = JSObject()
                    for ((k, cls) in types) {
                        if (!granted.contains(HealthPermission.getReadPermission(cls))) { errors.put(k, "not allowed"); continue }
                        try {
                            val arr = JSArray()
                            when (k) {
                                "hr" -> {
                                    val bins = java.util.TreeMap<Long, LongArray>()
                                    for (r in readAll(c, HeartRateRecord::class, range)) for (s in r.samples) {
                                        val m = sec(s.time) / 60
                                        val b = bins.getOrPut(m) { LongArray(2) }
                                        b[0] += s.beatsPerMinute; b[1] += 1
                                    }
                                    for ((m, b) in bins) arr.put(JSArray().put(m * 60).put(Math.round(b[0].toDouble() / b[1])))
                                }
                                "rhr" -> for (r in readAll(c, RestingHeartRateRecord::class, range))
                                    arr.put(JSArray().put(sec(r.time)).put(r.beatsPerMinute).put(r.metadata.dataOrigin.packageName))
                                "hrv" -> for (r in readAll(c, HeartRateVariabilityRmssdRecord::class, range))
                                    arr.put(JSArray().put(sec(r.time)).put(r.heartRateVariabilityMillis).put(r.metadata.dataOrigin.packageName))
                                "sleep" -> for (r in readAll(c, SleepSessionRecord::class, range)) {
                                    val st = JSArray()
                                    for (s in r.stages) st.put(JSArray().put(sec(s.startTime)).put(sec(s.endTime)).put(s.stage))
                                    arr.put(JSObject().put("s", sec(r.startTime)).put("e", sec(r.endTime))
                                        .put("src", r.metadata.dataOrigin.packageName).put("stages", st))
                                }
                                "exercise" -> for (r in readAll(c, ExerciseSessionRecord::class, range))
                                    arr.put(JSObject().put("s", sec(r.startTime)).put("e", sec(r.endTime)).put("type", r.exerciseType)
                                        .put("title", r.title ?: "").put("src", r.metadata.dataOrigin.packageName))
                                "active" -> for (r in readAll(c, ActiveCaloriesBurnedRecord::class, range))
                                    arr.put(JSArray().put(sec(r.startTime)).put(sec(r.endTime)).put(r.energy.inKilocalories).put(r.metadata.dataOrigin.packageName))
                                "total" -> for (r in readAll(c, TotalCaloriesBurnedRecord::class, range))
                                    arr.put(JSArray().put(sec(r.startTime)).put(sec(r.endTime)).put(r.energy.inKilocalories).put(r.metadata.dataOrigin.packageName))
                                "spo2" -> for (r in readAll(c, OxygenSaturationRecord::class, range))
                                    arr.put(JSArray().put(sec(r.time)).put(r.percentage.value))
                                "resp" -> for (r in readAll(c, RespiratoryRateRecord::class, range))
                                    arr.put(JSArray().put(sec(r.time)).put(r.rate))
                                "weight" -> for (r in readAll(c, WeightRecord::class, range))
                                    arr.put(JSArray().put(sec(r.time)).put(r.weight.inKilograms).put(r.metadata.dataOrigin.packageName))
                                "fat" -> for (r in readAll(c, BodyFatRecord::class, range))
                                    arr.put(JSArray().put(sec(r.time)).put(r.percentage.value))
                            }
                            res.put(k, arr)
                        } catch (e: Exception) { errors.put(k, e.message ?: e.javaClass.simpleName) }
                    }
                    res.put("errors", errors)
                    res
                }
                call.resolve(out)
            } catch (e: Exception) { call.reject(e.message ?: "couldn't read watch data") }
        }
    }
}
