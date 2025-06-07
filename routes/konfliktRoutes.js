// slot-buchungs-app/routes/konfliktRoutes.js
const express = require('express');
const router = express.Router();
const konfliktController = require('../controllers/konfliktController'); 

// @route   POST /api/konflikte/identifiziere-topf-konflikte
// @desc    Identifiziert Überbuchungen in Kapazitätstöpfen und legt Konfliktdokumente an
// @access  Admin/System (angenommen)
router.post('/identifiziere-topf-konflikte', konfliktController.identifiziereTopfKonflikte);

// @route   GET /api/konflikte
// @desc    Ruft alle Konfliktdokumentationen ab (optional filterbar)
// @access  Admin/System (angenommen)
router.get('/', konfliktController.getAllKonflikte);

// @route   GET /api/konflikte/:konfliktId
// @desc    Ruft eine spezifische Konfliktdokumentation ab
// @access  Admin/System (angenommen)
router.get('/:konfliktId', konfliktController.getKonfliktById);

// ROUTEN für die phasenweise Konfliktlösung der Kapazitätstöpfe
// Phase 1: Verzicht und Verschub
router.put('/:konfliktId/verzicht-verschub', konfliktController.verarbeiteVerzichtVerschub);

// Phase 2: Entgeltvergleich (wird später implementiert)
router.put('/:konfliktId/entgeltvergleich', konfliktController.fuehreEntgeltvergleichDurch);

// Phase 3: Höchstpreis-Ergebnis (wird später implementiert)
router.put('/:konfliktId/hoechstpreis-ergebnis', konfliktController.verarbeiteHoechstpreisErgebnis);


module.exports = router;