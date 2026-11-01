/**
 * Linglish App - Modular Entry Point
 *
 * This file serves as the main entry point for the application.
 * All functionality has been modularized into feature-based modules
 * located in /js/app/ for better maintainability and organization.
 *
 * ES6 Module Structure:
 * - state.js: Global state management
 * - auth.js: Authentication functions
 * - api.js: API client with error handling
 * - shadow-practice.js: Shadow practice feature
 * - dictogloss.js: Dictogloss practice feature
 * - timer-432.js: 4-3-2 timer feature
 * - vocabulary.js: Vocabulary and catalog management
 * - ui-manager.js: DOM manipulation and UI updates
 * - main.js: Application initialization and core logic
 */

// Import and re-export core modules
export * from './js/app/state.js?v=20251126010';
export * from './js/app/auth.js?v=2026103001';
export * from './js/app/api.js?v=20251126010';

// Import and re-export feature modules
export * from './js/app/shadow-practice.js?v=20251126010';
export * from './js/app/dictogloss.js?v=20251126010';
export * from './js/app/timer-432.js?v=20251126010';
export * from './js/app/vocabulary.js?v=20251126010';
export * from './js/app/ui-manager.js?v=20251126010';
export * from './js/app/stats-refresh.js?v=20251126010';

// Import main module (triggers DOMContentLoaded initialization)
import './js/app/main.js?v=2026103001';

// Export main functions for backward compatibility
export {
  bootstrapApp,
  refreshStats,
  refreshSessions,
} from './js/app/main.js?v=2026103001';
