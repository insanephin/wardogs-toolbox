// Maps the feed's internal cause codes (Id.Item.WEPN_029 and the like) to display names.
import { readFileSync, existsSync } from 'node:fs';

export type WeaponNames = Record<string, string>;

export function loadWeaponNames(path = 'data/weapons.json'): WeaponNames {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  delete raw._comment;
  return raw;
}

export function weaponName(names: WeaponNames, cause: string | null | undefined): string | null {
  if (!cause) return null;
  return names[cause] ?? cause.replace(/^Id\.Item\./, '').replace(/_/g, ' ');
}
