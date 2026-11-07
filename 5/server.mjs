/**
 * Ellie Life Enterprise — Servidor Principal Backend
 * Implementa API REST, Servicio de Archivos Estáticos y Workflows n8n compatibles.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { analyzeReportWithDeepSeek, runRulesOnlyFallback, generateEvidentialChatResponse } from './src/deepseek.mjs';
import { calculateHazardLevel, findPotentialDuplicates, prepareAlertDraft } from './src/rules-engine.mjs';
import { NotificationGateway } from './src/notification-gateway.mjs';
import { DataStore } from './src/store.mjs';
import { SupabaseBackendClient } from './src/supabase-client.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// Carga automática de .env si existe en entorno local (sin dependencias externas)
if (existsSync(join(rootDir, '.env'))) {
  try {
    const envContent = readFileSync(join(rootDir, '.env'), 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (_) {}
}

const publicDir = join(rootDir, 'public');
const port = Number(process.env.PORT || 4173);

export const store = new DataStore();
export const supabase = new SupabaseBackendClient();
export const gateway = new NotificationGateway();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('payload_too_large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

export const server = createServer(async (req, res) => {
  // Manejo de preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
    });
    return res.end();
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  try {
    // ----------------------------------------------------
    // 1. ENDPOINTS DE WORKFLOWS Y API
    // ----------------------------------------------------

    // WORKFLOW A: Entrada de reporte ciudadano (n8n compatible)
    if (req.method === 'POST' && (pathname === '/api/reports' || pathname === '/ellie/piura/report')) {
      const b = await parseBody(req);
      const description = String(b.description || '').trim();

      // Validación estricta
      if (!description || description.length < 3) {
        return sendJson(res, 400, { ok: false, error: 'description_required', message: 'La descripción debe tener al menos 3 caracteres.' });
      }

      const lat = Number(b.latitude);
      const lon = Number(b.longitude);
      const hasLocation = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      if (b.location_shared === true && !hasLocation) {
        return sendJson(res, 400, { ok: false, error: 'valid_location_required', message: 'Se indicó ubicación compartida pero las coordenadas no son válidas.' });
      }

      // Clasificación inicial de severidad
      const initialLevel = calculateHazardLevel({
        type: b.type,
        description,
        people_needing_help: b.people_needing_help === true
      });

      // Ejecutar DeepSeek o Fallback
      let aiAnalysis;
      if (b.skip_ai === true) {
        aiAnalysis = runRulesOnlyFallback({
          type: b.type,
          description,
          district: b.district,
          sector: b.sector,
          people_needing_help: b.people_needing_help === true
        });
      } else {
        aiAnalysis = await analyzeReportWithDeepSeek({
          type: b.type,
          description,
          district: b.district,
          sector: b.sector,
          people_needing_help: b.people_needing_help === true
        });
      }

      const publicCode = `REP-${Math.floor(1000 + Math.random() * 9000)}`;
      const incidentId = randomUUID();

      const incident = {
        id: incidentId,
        public_code: publicCode,
        reporter_id: b.reporter_id || null,
        type: aiAnalysis.type || b.type || 'otro',
        description,
        district: b.district || 'Piura',
        sector: aiAnalysis.sector || b.sector || null,
        latitude: hasLocation && b.location_shared === true ? lat : null,
        longitude: hasLocation && b.location_shared === true ? lon : null,
        location_precision_m: 500, // Siempre aproximada por defecto
        location_shared: hasLocation && b.location_shared === true,
        people_needing_help: b.people_needing_help === true,
        synthetic: b.synthetic === true,
        source: 'citizen',
        status: 'recibido', // Estado inicial obligatorio
        hazard_level: initialLevel,
        confidence: aiAnalysis.confidence,
        ai_provider: aiAnalysis.ai_provider,
        ai_model: aiAnalysis.ai_model,
        ai_used: aiAnalysis.ai_used,
        ai_missing: aiAnalysis.missing,
        ai_abstained: aiAnalysis.abstained,
        ai_rationale: aiAnalysis.rationale,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };

      // Guardar en almacén local
      store.incidents.set(incidentId, incident);

      // Sincronizar con Supabase si está configurado
      if (supabase.isConfigured()) {
        try {
          await supabase.insertIncident(incident);
        } catch (supaErr) {
          console.warn('[Supabase Sync Warning]:', supaErr.message);
        }
      }

      // Registro de Auditoría
      store.addAuditEvent({
        actor_id: b.reporter_id || null,
        event_type: 'REPORT_SUBMITTED',
        entity_type: 'incident',
        entity_id: incidentId,
        metadata: {
          public_code: publicCode,
          hazard_level: initialLevel,
          ai_used: aiAnalysis.ai_used,
          abstained: aiAnalysis.abstained
        }
      });

      return sendJson(res, 202, {
        ok: true,
        code: publicCode,
        id: incidentId,
        status: 'recibido',
        hazard_level: initialLevel,
        ai_used: aiAnalysis.ai_used,
        ai_provider: aiAnalysis.ai_provider,
        confidence: aiAnalysis.confidence,
        abstained: aiAnalysis.abstained,
        missing: aiAnalysis.missing,
        evidence_status: aiAnalysis.ai_used ? 'IA_ASISTIDA_PENDIENTE_REVISION' : 'RULES_ONLY_PENDIENTE_REVISION',
        message: 'Reporte recibido exitosamente. Requiere revisión humana obligatoria; no se ha enviado ninguna alerta automática.'
      });
    }

    // WORKFLOW B: Aprobación de alerta y notificación geográfica (n8n compatible)
    if (req.method === 'POST' && (pathname === '/api/moderation/approve' || pathname === '/ellie/piura/moderation/approve')) {
      const b = await parseBody(req);

      // Validaciones humanas estrictas
      if (b.decision !== 'approve') {
        return sendJson(res, 400, { ok: false, error: 'human_approval_required', message: 'Se requiere decisión explícita approve.' });
      }
      if (!b.alert_id || !b.moderator_id) {
        return sendJson(res, 400, { ok: false, error: 'alert_id_and_moderator_id_required', message: 'Falta alert_id o moderator_id.' });
      }
      if (!b.consent_confirmed) {
        return sendJson(res, 400, { ok: false, error: 'audience_consent_required', message: 'Debe confirmar el consentimiento de la audiencia.' });
      }

      const safeRadius = Math.min(Number(b.radius_m || 2000), 2000);
      const lat = Number(b.latitude || -5.1945); // Coordenada de referencia Piura
      const lon = Number(b.longitude || -80.6328);

      const alert = {
        id: b.alert_id,
        incident_id: b.incident_id || null,
        title: String(b.title || 'Alerta comunitaria preventiva — Piura'),
        body: String(b.body || 'Información en revisión preventiva. Consulta fuentes oficiales.'),
        hazard_level: b.hazard_level || 'medio',
        status: 'aprobada',
        radius_m: safeRadius,
        approved_by: b.moderator_id,
        approved_at: new Date().toISOString(),
        expires_at: b.expires_at || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      };
      store.alerts.set(alert.id, alert);

      // Buscar suscriptores dentro del radio con consentimiento vigente
      const recipients = store.findNearbySubscribers(lat, lon, safeRadius);

      // Realizar entregas con control de idempotencia
      const deliveryResults = [];
      for (const rec of recipients) {
        const consent = store.consent_records.get(rec.user_id) || {
          notifications_opt_in: true,
          sms_opt_in: rec.channel === 'sms'
        };

        const delivery = await gateway.deliver({
          alert,
          subscription: rec,
          consent,
          channel: rec.channel,
          isAssistanceRequest: b.is_assistance === true
        });

        deliveryResults.push(delivery);
      }

      // Registro de Auditoría
      store.addAuditEvent({
        actor_id: b.moderator_id,
        event_type: 'ALERT_HUMAN_APPROVED',
        entity_type: 'alert',
        entity_id: alert.id,
        metadata: {
          radius_m: safeRadius,
          recipients_found: recipients.length,
          deliveries: deliveryResults.length
        }
      });

      return sendJson(res, 202, {
        ok: true,
        message: 'Aprobación procesada. Notificaciones enviadas únicamente a suscripciones con consentimiento dentro del radio seguro.',
        alert_id: alert.id,
        radius_m: safeRadius,
        recipients_count: recipients.length,
        deliveries: deliveryResults
      });
    }

    // CHAT CONVERSACIONAL: Ellie Asistente (DeepSeek con Evidencias Multi-Capa)
    if (req.method === 'POST' && pathname === '/api/chat') {
      const b = await parseBody(req);
      const rawMessage = String(b.message || '').trim();
      const existingReports = Array.from(store.incidents.values());

      let responsePayload = await generateEvidentialChatResponse({
        message: rawMessage,
        existingReports
      });

      if (/borrador|alerta|prepar/i.test(rawMessage)) {
        const latestIncident = existingReports[0] || {
          id: randomUUID(),
          public_code: 'REP-DEMO-01',
          type: 'desborde_rio',
          district: 'Piura',
          sector: 'Malecón Eguiguren',
          hazard_level: 'medio'
        };
        const draft = prepareAlertDraft({
          incident: latestIncident,
          sector: latestIncident.sector,
          radius_m: 1500
        });
        responsePayload.draft_alert = draft;
      }

      return sendJson(res, 200, {
        ok: true,
        ...responsePayload,
        safety_notice: 'La IA no declara emergencias oficiales ni envía alertas automáticamente. Solo asiste a la moderación humana.'
      });
    }

    // LISTADO DE INCIDENTES
    if (req.method === 'GET' && pathname === '/api/incidents') {
      const all = Array.from(store.incidents.values()).sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
      return sendJson(res, 200, { ok: true, count: all.length, data: all });
    }

    // LISTADO DE AUTORIDADES OFICIALES PIURA
    if (req.method === 'GET' && pathname === '/api/authorities') {
      const all = Array.from(store.authorities.values());
      return sendJson(res, 200, { ok: true, count: all.length, data: all });
    }

    // LISTADO DE ALERTAS
    if (req.method === 'GET' && pathname === '/api/alerts') {
      const all = Array.from(store.alerts.values());
      return sendJson(res, 200, { ok: true, count: all.length, data: all });
    }

    // ACTUALIZACIÓN DE CONSENTIMIENTOS
    if (req.method === 'POST' && pathname === '/api/consent') {
      const b = await parseBody(req);
      const userId = b.user_id || 'user-anonimo';
      const consentRecord = {
        id: b.id || randomUUID(),
        user_id: userId,
        consent_version: 'piura-v1',
        notifications_opt_in: Boolean(b.notifications_opt_in),
        location_opt_in: Boolean(b.location_opt_in),
        sms_opt_in: Boolean(b.sms_opt_in),
        ai_processing_opt_in: Boolean(b.ai_processing_opt_in),
        share_authority_opt_in: Boolean(b.share_authority_opt_in),
        share_family_opt_in: Boolean(b.share_family_opt_in),
        granted_at: new Date().toISOString(),
        revoked_at: b.revoked === true ? new Date().toISOString() : null
      };
      store.consent_records.set(userId, consentRecord);

      store.addAuditEvent({
        actor_id: userId,
        event_type: 'CONSENT_UPDATED',
        entity_type: 'consent_records',
        entity_id: consentRecord.id,
        metadata: consentRecord
      });

      return sendJson(res, 200, { ok: true, consent: consentRecord });
    }

    // ELIMINACIÓN DE DATOS DE USUARIO (DERECHO AL OLVIDO)
    if (req.method === 'DELETE' && pathname === '/api/user-data') {
      const b = await parseBody(req);
      const userId = b.user_id;
      if (!userId) {
        return sendJson(res, 400, { ok: false, error: 'user_id_required' });
      }

      let deletedIncidents = 0;
      for (const [id, inc] of store.incidents.entries()) {
        if (inc.reporter_id === userId) {
          store.incidents.delete(id);
          deletedIncidents++;
        }
      }

      store.consent_records.delete(userId);

      store.addAuditEvent({
        actor_id: userId,
        event_type: 'USER_DATA_DELETED',
        entity_type: 'user',
        entity_id: userId,
        metadata: { deleted_incidents: deletedIncidents }
      });

      return sendJson(res, 200, {
        ok: true,
        message: 'Datos y reportes del usuario eliminados conforme a la política de privacidad.',
        deleted_incidents: deletedIncidents
      });
    }

    // HEALTHCHECK
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'Ellie Life Enterprise — Piura',
        status: 'healthy',
        time: new Date().toISOString(),
        deepseek_configured: Boolean(process.env.DEEPSEEK_API_KEY || process.env.NVIDIA_API_KEY),
        supabase_configured: supabase.isConfigured()
      });
    }

    // ----------------------------------------------------
    // 2. SERVIR ARCHIVOS ESTÁTICOS DE LA INTERFAZ
    // ----------------------------------------------------
    let filePath = join(publicDir, pathname === '/' ? 'index.html' : pathname);
    filePath = normalize(filePath);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Acceso denegado');
    }

    try {
      const data = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
      });
      res.end(data);
    } catch {
      // Fallback a index.html para Single Page App
      try {
        const indexData = await readFile(join(publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(indexData);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
    }
  } catch (err) {
    console.error('[Server Error]:', err);
    sendJson(res, 500, { ok: false, error: 'internal_server_error', message: err.message });
  }
});

// Iniciar servidor solo si se ejecuta directamente
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`Ellie Life Enterprise — Seguridad y Evacuación (Piura)`);
    console.log(`Servidor activo en: http://localhost:${port}`);
    console.log(`Endpoints n8n:`);
    console.log(`  - POST /ellie/piura/report`);
    console.log(`  - POST /ellie/piura/moderation/approve`);
    console.log(`=======================================================`);
  });
}
