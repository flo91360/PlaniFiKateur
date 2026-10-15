// Rattrapage des webhooks GitHub perdus (redéploiement du site, panne de livraison) : pour chaque
// PR de l’agent en attente de tests ou de fusion depuis quelques minutes, le serveur relit lui-même
// la PR et les exécutions de son workflow auprès de l’API GitHub, puis applique exactement les mêmes
// règles qu’au webhook signé (githubMerged, githubChecks). Le worker ne peut rien affirmer ici.
export function createGithubSync(
  store,
  {
    transport = fetch,
    token = '',
    intervalMs = 5 * 60000,
    quietMs = 3 * 60000,
    onError = console.error,
    start = true,
  } = {},
) {
  let running = false,
    closed = false;
  const read = async path => {
    const response = await transport(`https://api.github.com${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PlaniFiKateur',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub a répondu ${response.status}.`);
    return response.json();
  };
  const reported = new Map();
  const refresh = async () => {
    if (running || closed) return { checked: 0 };
    running = true;
    let checked = 0;
    try {
      for (const pending of store.workflows.mergingPullRequests({ quietMs })) {
        if (closed) break;
        const { repository, number, headSha, workflowFile } = pending;
        try {
          const event = { repository: { full_name: repository } };
          const pr = await read(`/repos/${repository}/pulls/${number}`);
          if (pr.merged) {
            store.workflows.githubMerged({ ...event, action: 'closed', pull_request: pr });
          } else {
            const query = new URLSearchParams({ event: 'pull_request', head_sha: headSha, per_page: '20' });
            const { workflow_runs: runs = [] } = await read(
              `/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${query}`,
            );
            // Du plus ancien au plus récent : le dernier verdict l’emporte, comme avec les webhooks.
            for (const run of runs.filter(item => item.status === 'completed').sort((a, b) => a.id - b.id))
              store.workflows.githubChecks({ ...event, action: 'completed', workflow_run: run });
          }
          reported.delete(pending.executionId);
          checked++;
        } catch (error) {
          // Une PR inaccessible n’empêche pas de vérifier les autres ; l’erreur n’est signalée qu’une fois.
          const message = error.code || error.message;
          if (reported.get(pending.executionId) !== message)
            onError(`PlaniFiKateur : vérification GitHub de ${repository}#${number} impossible (${message}).`);
          reported.set(pending.executionId, message);
        }
      }
    } catch (error) {
      // Lancé par un minuteur : une erreur locale (base indisponible…) ne doit pas arrêter le serveur.
      onError(`PlaniFiKateur : vérification des PR GitHub impossible (${error.message}).`);
    } finally {
      running = false;
    }
    return { checked };
  };
  const timer = start ? setInterval(() => void refresh(), intervalMs) : null;
  timer?.unref();
  return {
    refresh,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
