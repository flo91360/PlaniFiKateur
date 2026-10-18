// Un ancien worker posait cette question technique au lieu de republier sa PR ; le site la
// reconnaît aussi. Une vraie demande de précision exige toujours une réponse humaine.
export const LEGACY_PUBLICATION_QUESTION = 'La PR ne pointe pas sur le commit testé.';
export const legacyPublicationQuestion = run =>
  run.state === 'waiting' &&
  !!run.submissions.at(-1)?.pullRequest &&
  run.exchanges.at(-1)?.question === LEGACY_PUBLICATION_QUESTION &&
  !run.exchanges.at(-1)?.answer;
