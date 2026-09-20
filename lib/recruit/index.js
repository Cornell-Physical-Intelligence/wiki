// The manifest: every recruitment module, mounted once. Add a module by
// importing it here and adding it to the list; the registry sorts by order.
import { createRecruit } from './registry.js';
import cycles from './modules/cycles.js';
import applications from './modules/applications.js';
import roles from './modules/roles.js';
import pipeline from './modules/pipeline.js';
import review from './modules/review.js';
import interviews from './modules/interviews.js';
import comms from './modules/comms.js';
import analytics from './modules/analytics.js';
import onboarding from './modules/onboarding.js';
import forms from './modules/forms.js';

export const { MODULES, handleRecruit, intakeBridge, kitFor } = createRecruit([cycles, applications, roles, pipeline, review, interviews, comms, analytics, onboarding, forms]);
