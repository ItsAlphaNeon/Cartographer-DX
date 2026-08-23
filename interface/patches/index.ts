import * as affordable from './affordable';
import * as carpet from './carpet';
import * as concrete from './concrete';
import * as full from './full';

export default [
  {
    name: 'Full',
    patch: full.patch
  },
  {
    name: 'Affordable',
    patch: affordable.patch
  },
  {
    name: 'Carpet',
    patch: carpet.patch
  },
  {
    name: 'Concrete Powder',
    patch: concrete.patch
  }
];
