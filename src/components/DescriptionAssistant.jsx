import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Square, Undo2, WandSparkles } from 'lucide-react';
import { workRequest } from './AgentSetup.jsx';

const unsupported = 'La dictée n’est pas prise en charge par ce navigateur. Utilisez Chrome, Edge ou Safari.';
const speechErrors = {
  'not-allowed': 'Accès au micro refusé. Autorisez le micro pour ce site dans le navigateur, puis réessayez.',
  'service-not-allowed': 'La reconnaissance vocale est bloquée par le navigateur. Autorisez le micro pour ce site, puis réessayez.',
  'audio-capture': 'Aucun micro n’est disponible sur cet appareil.',
  network: 'Le service de reconnaissance vocale du navigateur est injoignable. Vérifiez la connexion, ou utilisez Chrome, Edge ou Safari.',
  'language-not-supported': 'Le français n’est pas pris en charge par la reconnaissance vocale de ce navigateur.',
};
const interrupted = 'La dictée s’est interrompue de façon inattendue. Réessayez.';
const duration = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const joinParts = parts => parts.map(part => part.trim()).filter(Boolean).join(' ');

export function appendDictation(current, dictated) {
  const text = dictated.trim();
  if (!text) return current;
  const sentence = text[0].toLocaleUpperCase('fr') + text.slice(1);
  if (!current.trim()) return sentence;
  return /\s$/.test(current) ? current + sentence : `${current} ${sentence}`;
}

// Reconnaissance vocale du navigateur (Web Speech API) : aucune clé ni envoi au serveur du site.
function useDictation(onDictated) {
  const [state, setState] = useState({ listening: false, preview: '', seconds: 0, error: '' });
  const session = useRef(null);
  const dictated = useRef(onDictated);
  dictated.current = onDictated;
  useEffect(() => () => { const current = session.current; session.current = null; current?.recognition.abort(); }, []);
  useEffect(() => {
    if (!state.listening) return;
    const started = Date.now();
    const timer = setInterval(() => setState(s => ({ ...s, seconds: Math.floor((Date.now() - started) / 1000) })), 1000);
    return () => clearInterval(timer);
  }, [state.listening]);

  const start = () => {
    const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!Recognition) { setState(s => ({ ...s, error: unsupported })); return; }
    const recognition = new Recognition();
    const current = { recognition, committed: [], final: [], interim: '', stopping: false, error: '', startedAt: Date.now(), quickEnds: 0 };
    recognition.lang = 'fr-FR';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = event => {
      if (session.current !== current) return;
      const results = Array.from(event.results);
      current.final = results.filter(result => result.isFinal).map(result => result[0]?.transcript || '');
      current.interim = joinParts(results.filter(result => !result.isFinal).map(result => result[0]?.transcript || ''));
      setState(s => ({ ...s, preview: joinParts([...current.committed, ...current.final, current.interim]) }));
    };
    recognition.onerror = event => {
      if (session.current !== current || !speechErrors[event.error]) return;
      current.error = speechErrors[event.error]; current.stopping = true;
    };
    recognition.onend = () => {
      if (session.current !== current) return;
      current.committed.push(...current.final, current.interim);
      current.final = []; current.interim = '';
      current.quickEnds = Date.now() - current.startedAt < 1000 ? current.quickEnds + 1 : 0;
      if (current.quickEnds >= 3 && !current.stopping) { current.error = interrupted; current.stopping = true; }
      if (!current.stopping) {
        // Les navigateurs coupent l’écoute après un silence : elle reprend jusqu’à l’arrêt demandé.
        try { current.startedAt = Date.now(); recognition.start(); return; }
        catch { current.error = interrupted; }
      }
      session.current = null;
      const text = joinParts(current.committed);
      setState({ listening: false, preview: '', seconds: 0, error: current.error });
      if (text) dictated.current(text);
    };
    try { recognition.start(); }
    catch { setState(s => ({ ...s, error: interrupted })); return; }
    session.current = current;
    setState({ listening: true, preview: '', seconds: 0, error: '' });
  };
  const stop = () => {
    const current = session.current;
    if (!current) return;
    current.stopping = true;
    current.recognition.stop();
  };
  return { ...state, start, stop };
}

export default function DescriptionAssistant({ value, onChange, offline = false, projectId, title = '', listId = '' }) {
  const latest = useRef(value);
  latest.current = value;
  const dictation = useDictation(text => onChange(appendDictation(latest.current, text)));
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [exchanges, setExchanges] = useState([]);
  const [undo, setUndo] = useState(null);
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  const refine = async (history = []) => {
    request.current?.abort();
    const controller = request.current = new AbortController();
    setRefining(true); setError('');
    try {
      const result = await workRequest(`projects/${projectId}/refine`, 'POST', { title, description: latest.current, listId, exchanges: history.slice(-20) }, controller.signal);
      if (request.current !== controller) return;
      setProposal(result); setAnswers(result.questions.map(() => '')); setExchanges(history);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message);
    } finally {
      if (request.current === controller) { request.current = null; setRefining(false); }
    }
  };
  const answered = () => (proposal?.questions || []).map((question, index) => ({ question, answer: (answers[index] || '').trim() })).filter(item => item.answer);
  const apply = () => {
    setUndo({ previous: value, applied: proposal.prompt });
    onChange(proposal.prompt);
    setProposal(null); setExchanges([]);
  };
  const discard = () => { request.current?.abort(); setProposal(null); setExchanges([]); setError(''); };

  return <div className="description-assistant">
    <div className="assistant-toolbar">
      {dictation.listening
        ? <button type="button" className="assistant-button recording" aria-label="Arrêter la dictée" onClick={dictation.stop}><Square size={13} />Arrêter<span className="assistant-timer">{duration(dictation.seconds)}</span></button>
        : <button type="button" className="assistant-button" aria-label="Dicter la description" disabled={refining} onClick={dictation.start}><Mic size={15} />Dicter</button>}
      {!offline && <button type="button" className="assistant-button magic" aria-label="Reformuler avec l’IA" disabled={refining || dictation.listening || !value.trim()} onClick={() => void refine()}>
        {refining ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}{refining ? 'Analyse en cours…' : 'Reformuler avec l’IA'}
      </button>}
    </div>
    {dictation.listening && <p className="dictation-live" aria-live="polite"><span className="recording-dot" />{dictation.preview || 'Parlez : la transcription s’affiche ici et s’ajoutera à la description à l’arrêt.'}</p>}
    {dictation.error && <p className="form-error" role="alert">{dictation.error}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {undo && value === undo.applied && !proposal && <p className="assistant-note">Description remplacée par la proposition de l’IA.<button type="button" className="link-button" onClick={() => { onChange(undo.previous); setUndo(null); }}><Undo2 size={13} />Rétablir le texte précédent</button></p>}
    {proposal && <section className="refinement" aria-label="Proposition de l’IA">
      <header><WandSparkles size={15} /><strong>Proposition de l’IA</strong>{proposal.model && <small>{proposal.model}</small>}</header>
      {proposal.sources?.length > 0 && <p className="refinement-sources">Documentation du dépôt utilisée : {proposal.sources.join(', ')}</p>}
      <p className="muted">Relisez et ajustez la demande reformulée avant de remplacer la description. Rien n’est modifié tant que vous ne l’appliquez pas.</p>
      <textarea aria-label="Demande reformulée" rows={10} value={proposal.prompt} onChange={e => setProposal(p => ({ ...p, prompt: e.target.value }))} />
      {proposal.questions.length > 0 && <div className="refinement-questions">
        <h4>Points à préciser</h4>
        <p className="muted">Répondez aux questions utiles puis relancez la reformulation, ou appliquez la proposition telle quelle.</p>
        {proposal.questions.map((question, index) => <label key={index}>{question}<textarea aria-label={`Réponse : ${question}`} rows={2} value={answers[index] || ''} onChange={e => setAnswers(list => list.map((answer, i) => i === index ? e.target.value : answer))} placeholder="Votre réponse…" /></label>)}
      </div>}
      <div className="refinement-actions">
        <button type="button" className="primary-button" disabled={refining || !proposal.prompt.trim()} onClick={apply}>Remplacer la description</button>
        {proposal.questions.length > 0 && <button type="button" className="secondary-button" disabled={refining || !answered().length} onClick={() => void refine([...exchanges, ...answered()])}>{refining ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}Reformuler avec mes réponses</button>}
        <button type="button" className="secondary-button" onClick={discard}>Ignorer</button>
      </div>
    </section>}
  </div>;
}
