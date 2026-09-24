export interface CompetencyScores {
  frontend?: number;
  backend?: number;
  databases?: number;
  problem_solving?: number;
}

export interface ReadinessResult {
  score: number;
  status:
    | 'READY'
    | 'NEARLY_READY'
    | 'DEVELOPING'
    | 'NEEDS_PREPARATION'
    | 'INCOMPLETE';
}

export function calculateReadiness(
  scores: CompetencyScores
): ReadinessResult {
  const {
    frontend,
    backend,
    databases,
    problem_solving,
  } = scores;

  if (
    frontend === undefined ||
    backend === undefined ||
    databases === undefined ||
    problem_solving === undefined
  ) {
    return {
      score: 0,
      status: 'INCOMPLETE',
    };
  }

  const weightedScore =
    frontend * 0.30 +
    backend * 0.30 +
    databases * 0.25 +
    problem_solving * 0.15;

  const roundedScore =
    Math.round(weightedScore * 100) / 100;

  let status: ReadinessResult['status'];

  if (roundedScore >= 80) {
    status = 'READY';
  } else if (roundedScore >= 70) {
    status = 'NEARLY_READY';
  } else if (roundedScore >= 55) {
    status = 'DEVELOPING';
  } else {
    status = 'NEEDS_PREPARATION';
  }

  return {
    score: roundedScore,
    status,
  };
}