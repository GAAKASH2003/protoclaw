
export function nextEvenSeq(currentMax: number | null | undefined): number {
  const max = currentMax ?? 0;
  if (max < 2) return 2;
  return max + 2 - (max % 2);
}



export function nextOddSeq(currentMax: number | null | undefined): number {
  const max = currentMax ?? 0;
  if (max < 1) return 1;
  return max % 2 === 0 ? max + 1 : max + 2;
}

export function isHostSeq(seq: number): boolean {
  return seq > 0 && seq % 2 === 0;
}

export function isRunnerSeq(seq: number): boolean {
  return seq > 0 && seq % 2 !== 0;
}

export function originFromSeq(seq: number): 'host' | 'runner' {
  return isHostSeq(seq) ? 'host' : 'runner';
}
