/**
 * A machine whose folders can be browsed (decision 0013 §8) — what the folder browser lists and hands
 * back with the folder chosen on it. A type only.
 */
export interface BrowseMachine {
  id: string;
  label: string;
}
