export const CARELINK_TREND_TO_NIGHTSCOUT_TREND: Record<string, { trend: number; direction: string }> = {
  // 'NONE' from CareLink means "no-change"; Nightscout convention is
  // trend=4 direction='Flat'. nightscout-connect maps the same key to
  // {trend:4, direction:'Flat'}; matches every other CGM source's flat.
  NONE: { trend: 4, direction: 'Flat' },
  UP_TRIPLE: { trend: 1, direction: 'TripleUp' },
  UP_DOUBLE: { trend: 1, direction: 'DoubleUp' },
  UP: { trend: 2, direction: 'SingleUp' },
  DOWN: { trend: 6, direction: 'SingleDown' },
  DOWN_DOUBLE: { trend: 7, direction: 'DoubleDown' },
  DOWN_TRIPLE: { trend: 7, direction: 'TripleDown' },
};
