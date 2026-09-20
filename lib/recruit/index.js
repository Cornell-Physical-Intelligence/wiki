// The manifest: every recruitment module, mounted once. Cycles, their
// submissions, per-cycle roles, and the website endpoints. Add a module by
// importing it here and adding it to the list; the registry sorts by order.
import { createRecruit } from './registry.js';
import cycles from './modules/cycles.js';
import applications from './modules/applications.js';
import roles from './modules/roles.js';
import site from './modules/site.js';

export const { MODULES, handleRecruit, intakeBridge, kitFor } = createRecruit([cycles, applications, roles, site]);
