import { connectionDiagnostic, temporaryConnectionError } from './clients.mjs';

const EXPIRED = 'Réservation expirée : le site n’a pas confirmé sa prolongation.';

// Réservation d’une exécution prise en charge : le jeton de bail accompagne chaque action,
// un heartbeat la prolonge, et la tâche est interrompue (signal) si le site ne confirme plus.
// `run` suit la dernière version renvoyée par le site.
export class WorkerTimeoutError extends Error {
  constructor(phase, duration) {
    super(`Délai dépassé (${phase}, ${Math.round(duration / 1000)} s). Une reprise automatique est prévue.`);
    this.name = 'WorkerTimeoutError';
  }
}

export function createReservation({ site, run, config, log, parentSignal }) {
  const token = run.leaseToken;
  const controller = new AbortController();
  const total = new AbortController();
  const totalTimer = setTimeout(
    () => total.abort(new WorkerTimeoutError('exécution complète', config.taskTimeoutMs)),
    config.taskTimeoutMs,
  );
  totalTimer.unref();
  let phaseSignal;
  const signal = AbortSignal.any([controller.signal, total.signal, ...(parentSignal ? [parentSignal] : [])]);
  let deadline = Date.parse(run.leaseExpiresAt),
    deadlineTimer,
    failed = false,
    heartbeating = false,
    heartbeatPromise;
  const lose = message => {
    failed = true;
    controller.abort(new Error(message));
  };
  const renew = response => {
    const expires = Date.parse(response.leaseExpiresAt);
    if (!Number.isFinite(expires)) return;
    deadline = Math.max(deadline || 0, expires);
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => lose(EXPIRED), Math.max(0, deadline - Date.now()));
    deadlineTimer.unref();
  };
  const reservation = {
    run,
    get signal() {
      return phaseSignal || signal;
    },
    async phase(name, duration, work) {
      const phase = new AbortController();
      const timer = setTimeout(() => phase.abort(new WorkerTimeoutError(name, duration)), duration);
      timer.unref();
      const current = AbortSignal.any([signal, phase.signal]);
      phaseSignal = current;
      try {
        current.throwIfAborted();
        const result = await work();
        current.throwIfAborted();
        return result;
      } catch (error) {
        if (current.aborted) throw current.reason;
        throw error;
      } finally {
        clearTimeout(timer);
        phaseSignal = undefined;
      }
    },
    token,
    // Vrai si la tâche a été arrêtée faute de prolongation : ce n’est pas un échec du modèle.
    get failed() {
      return failed;
    },
    get failure() {
      return controller.signal.reason?.message;
    },
    async action(name, data = {}, actionSignal = reservation.signal) {
      const response = await site.action({ ...reservation.run, leaseToken: token }, name, data, actionSignal);
      reservation.run = { ...response, leaseToken: token };
      if (reservation.run.state === 'running') renew(reservation.run);
      else {
        clearInterval(heartbeat);
        clearTimeout(deadlineTimer);
      }
      return reservation.run;
    },
    async stop() {
      clearInterval(heartbeat);
      clearTimeout(totalTimer);
      await heartbeatPromise;
      clearTimeout(deadlineTimer);
    },
  };
  renew(run);
  const heartbeat = setInterval(() => {
    if (heartbeating || signal.aborted) return;
    heartbeating = true;
    // Heartbeat does not change the version; do not overwrite a parallel action.
    heartbeatPromise = site
      .action({ ...reservation.run, leaseToken: token }, 'heartbeat', {}, signal)
      .then(response => {
        if (reservation.run.state === 'running') renew(response);
      })
      .catch(error => {
        if (signal.aborted || reservation.run.state !== 'running') return;
        const diagnostic = connectionDiagnostic(error);
        if (temporaryConnectionError(error) && Date.now() < deadline) {
          log(
            `Exécution ${reservation.run.id} : prolongation temporairement indisponible (${diagnostic}), nouvelle tentative prévue.`,
          );
          return;
        }
        lose(
          temporaryConnectionError(error) && Date.now() >= deadline ? EXPIRED : `Réservation perdue (${diagnostic}).`,
        );
      })
      .finally(() => {
        heartbeating = false;
      });
  }, config.heartbeatMs);
  heartbeat.unref();
  return reservation;
}
