// slot-buchungs-app/routes/konfliktRoutes.js
const express = require('express');
const router = express.Router();
const konfliktController = require('../controllers/konfliktController'); 

// @route   POST /api/konflikte/identifiziere-topf-konflikte
// @desc    Identifiziert Überbuchungen in Kapazitätstöpfen und legt Konfliktdokumente an, bildet dabei zusätzlich Gruppen von Konflikten mit identischen beteiligten Anfragen
// @access  Admin/System (angenommen)
router.post('/identifiziere-topf-konflikte', konfliktController.identifiziereTopfKonflikte);

// ROUTE zum Abruf aller Gruppen von Konflikten
// @route   GET /api/konflikte/gruppen
// @desc    Ruft alle Gruppen von Konflikten mit identischen beteiligten Anfragen ab
// @access  Admin/System
router.get('/gruppen', konfliktController.identifiziereKonfliktGruppen);

// @route   GET /api/konflikte
// @desc    Ruft alle Konfliktdokumentationen ab (optional filterbar)
// @access  Admin/System (angenommen)
router.get('/', konfliktController.getAllKonflikte);

// @route   GET /api/konflikte/:konfliktId
// @desc    Ruft eine spezifische Konfliktdokumentation ab
// @access  Admin/System (angenommen)
router.get('/:konfliktId', konfliktController.getKonfliktById);

// ROUTEN für die phasenweise Konfliktlösung der Kapazitätstöpfe
// Phase 1: Verzicht und Verschub für einen Konflikt
router.put('/:konfliktId/verzicht-verschub', konfliktController.verarbeiteVerzichtVerschub);

// Phase 2: Entgeltvergleich für einen Konflikt
// @desc    Führt den Entgeltvergleich für einen EINZELNEN Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/entgeltvergleich
router.put('/:konfliktId/entgeltvergleich', konfliktController.fuehreEntgeltvergleichDurch);

// Phase 3: Höchstpreis-Ergebnis für einen Konflikt
// @desc    Führt das Höchstpreisverfahren für einen EINZELNEN Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/hoechstpreis-ergebnis
router.put('/:konfliktId/hoechstpreis-ergebnis', konfliktController.verarbeiteHoechstpreisErgebnis);

// ROUTEN für die phasenweise GRUPPEN-Konfliktlösung
// Phase 1: Verzicht und Verschub für eine Gruppe
// @route   PUT /api/konflikte/gruppen/:gruppenId/verzicht-verschub
// @desc    Phase 1: Verarbeitet Verzichte/Verschiebungen für eine ganze Konfliktgruppe
// @access  Admin/System
router.put('/gruppen/:gruppenId/verzicht-verschub', konfliktController.verarbeiteGruppenVerzichtVerschub);


// ROUTE für Gruppen-Entgeltvergleich
// Phase 2: Entgeltvergleich für eine Gruppe identischer Konflikte
// @route   PUT /api/konflikte/gruppen/:gruppenId/entgeltvergleich
// @desc    Phase 2: Führt Entgeltvergleich zur Konfliktlösung für eine ganze Konfliktgruppe durch
// @access  Admin/System
router.put('/gruppen/:gruppenId/entgeltvergleich', konfliktController.fuehreGruppenEntgeltvergleichDurch);

// ROUTEN für Gruppen- und Einzel-Höchstpreisverfahren
// Phase 3: Höchstpreisverfahren für eine Gruppe identischer Konflikte
// @route   PUT /api/konflikte/gruppen/:gruppenId/hoechstpreis-ergebnis
// @desc    Phase 3: Führt Höchstpreisverfahren zur Konfliktlösung für eine ganze Konfliktgruppe durch
// @access  Admin/System
router.put('/gruppen/:gruppenId/hoechstpreis-ergebnis', konfliktController.verarbeiteGruppenHoechstpreisErgebnis);

// ROUTE für die Verschiebungs-Analyse
// @route   GET /api/konflikte/gruppen/:gruppenId/verschiebe-analyse
// @desc    Analysiert die Kapazität der Nachbartöpfe für eine Konfliktgruppe
// @access  Admin/System
router.get('/gruppen/:gruppenId/verschiebe-analyse', konfliktController.getVerschiebeAnalyseFuerGruppe);

// ROUTE für die Alternativen-Analyse
// @route   GET /api/konflikte/gruppen/:gruppenId/alternativen
// @desc    Findet komplett freie alternative Slots für eine Konfliktgruppe
// @access  Admin/System
router.get('/gruppen/:gruppenId/alternativen', konfliktController.getAlternativSlotsFuerGruppe);



module.exports = router;