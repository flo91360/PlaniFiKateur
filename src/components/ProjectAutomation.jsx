import React, { useEffect, useState } from 'react';
import GithubSetup from './GithubSetup.jsx';
import AgentSetup, { workRequest } from './AgentSetup.jsx';
import WorkPanel from './WorkPanel.jsx';

export default function ProjectAutomation({ project, user, settings, canAct, onRefresh, onEdit }) {
  const [configuration, setConfiguration] = useState(null), [error, setError] = useState('');
  const [cardId, setCardId] = useState(project.cards[0]?.id || '');
  const card = project.cards.find(item => item.id === cardId) || project.cards[0];
  useEffect(() => {
    const controller = new AbortController();
    workRequest(`projects/${project.id}/github`, 'GET', null, controller.signal)
      .then(setConfiguration).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [project.id]);
  return <div className="accounts-panel project-automation">
    <p><strong>{project.name}</strong> · identifiant : <code>{project.id}</code></p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!configuration && !error && <p role="status">Chargement des paramètres…</p>}
    {configuration && (settings ? <>
      <p>Le dépôt et les autorisations de l’agent s’appliquent à toutes les cartes de ce projet. La livraison passe toujours par une PR fusionnée automatiquement après réussite des tests.</p>
      {user.role === 'admin' ? <><GithubSetup projectId={project.id} configuration={configuration} onConfigured={setConfiguration} /><AgentSetup projectId={project.id} /></> : <p>Dépôt : {configuration.repository || 'non configuré'}. Un administrateur peut modifier ces paramètres.</p>}
    </> : <>
      {card ? <><label>Carte à traiter<select aria-label="Carte à traiter" value={card.id} onChange={event => setCardId(event.target.value)}>{project.cards.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <p className="work-text">{card.description || 'Ajoutez une description à cette carte avant de lancer la tâche.'}</p>
        <button className="secondary-button" onClick={() => onEdit(card.id)}>Modifier la carte</button>
        <WorkPanel key={card.id} projectId={project.id} cardId={card.id} card={card} configuration={configuration} canAct={canAct} onRefresh={onRefresh} />
      </> : <p>Ajoutez une carte au projet pour préparer une tâche.</p>}
    </>)}
  </div>;
}
