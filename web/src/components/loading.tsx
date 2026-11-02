export const busy = (on: boolean) => (on ? { 'aria-busy': true, inert: true } as const : {});
