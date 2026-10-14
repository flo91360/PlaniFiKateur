import React from 'react';

// Garde-fou d’affichage : une donnée inattendue dans un composant affiche `fallback` au lieu
// d’une page blanche. Un changement de `resetKey` (autre carte, autre fenêtre) réessaie l’affichage.
export default class ErrorBoundary extends React.Component {
  state = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  componentDidCatch(error, info) {
    console.error('PlaniFiKateur : erreur d’affichage', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const reset = () => this.setState({ error: null });
    return this.props.fallback ? this.props.fallback({ error: this.state.error, reset }) : <DisplayError />;
  }
}

// Message par défaut : l’affichage d’une partie de la page a échoué, les données ne sont pas touchées.
export function DisplayError({ message = 'Cette partie de la page n’a pas pu s’afficher.', children }) {
  return (
    <div className="sync-warning display-error" role="alert">
      <p>
        {message} Vos données ne sont pas modifiées. Rechargez la page ; si l’erreur revient, signalez-la avec l’action
        effectuée.
      </p>
      {children}
      <button className="secondary-button" onClick={() => window.location.reload()}>
        Recharger la page
      </button>
    </div>
  );
}
