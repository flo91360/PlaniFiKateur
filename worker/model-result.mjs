export function parseModelResult(response) {
  let result;
  try { result = typeof response === 'string' ? JSON.parse(response) : response; }
  catch {
    const question = String(response).trim();
    if (question && question.length <= 10000 && question.endsWith('?')) return { status: 'question', summary: '', question, files: [] };
    throw new Error('Réponse IA non conforme au JSON attendu.');
  }
  if (!result || typeof result !== 'object') throw new Error('Résultat IA incomplet.');
  if (typeof result.question === 'string' && result.question.trim()) result = { ...result, status: 'question', files: [] };
  if (!['question', 'result'].includes(result.status) || typeof result.summary !== 'string' || result.summary.length > 20000 || typeof result.question !== 'string' || (result.status === 'question' && (!result.question.trim() || result.question.length > 10000)) || (result.status === 'result' && !result.summary.trim())) throw new Error('Résultat IA incomplet.');
  if (result.files !== undefined && (!Array.isArray(result.files) || result.files.length > 10 || result.files.some(file => typeof file !== 'string' || !file.trim() || file.length > 1024))) throw new Error('Liste des fichiers générés invalide.');
  return result;
}
