// slot-buchungs-app/routes/konfliktRoutes.js
const express = require('express');
const router = express.Router();
const konfliktController = require('../controllers/konfliktController'); 

// ROUTE für Kapazitätstopf-Konflikterkennung
// @route   POST /api/konflikte/identifiziere-topf-konflikte
// @desc    Identifiziert Überbuchungen in Kapazitätstöpfen und legt Konfliktdokumente an, bildet dabei zusätzlich Gruppen von Konflikten mit identischen beteiligten Anfragen
// @access  Admin/System (angenommen)
router.post('/identifiziere-topf-konflikte', konfliktController.identifiziereTopfKonflikte);

// ROUTE für Slot-Konflikterkennung
// @route   POST /api/konflikte/identifiziere-slot-konflikte
// @desc    Identifiziert Überbuchungen in Slots und legt Konfliktdokumente an, bildet dabei zusätzlich Gruppen von Konflikten mit identischen beteiligten Anfragen
// @access  Admin/System (angenommen)
router.post('/identifiziere-slot-konflikte', konfliktController.identifiziereSlotKonflikte);


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

// Phase 1: Verzicht und Verschub für einen Topf-Konflikt
// @desc    Führt Verzicht / Verschub für einen EINZELNEN Topf-Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/verzicht-verschub
router.put('/:konfliktId/verzicht-verschub', konfliktController.verarbeiteVerzichtVerschub);

// Phase 1: Verzicht und Verschub für einen Slot-Konflikt
// @desc    Führt Verzicht / Verschub für einen EINZELNEN Slot-Konflikt durch
// @route   PUT /api/konflikte/slot/:konfliktId/verzicht-verschub
router.put('/slot/:konfliktId/verzicht-verschub', konfliktController.verarbeiteEinzelSlotVerzichtVerschub);

// Phase 2: Entgeltvergleich für einen Topf-Konflikt
// @desc    Führt den Entgeltvergleich für einen EINZELNEN Topf-Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/entgeltvergleich
router.put('/:konfliktId/entgeltvergleich', konfliktController.fuehreEntgeltvergleichDurch);

// Phase 2: Entgeltvergleich für einen Slot-Konflikt
// @desc    Führt den Entgeltvergleich für einen EINZELNEN Slot-Konflikt durch
// @route   PUT /api/konflikte/slot/:konfliktId/entgeltvergleich
router.put('/slot/:konfliktId/entgeltvergleich', konfliktController.fuehreEinzelSlotEntgeltvergleichDurch);

// Phase 3: Höchstpreis-Ergebnis für einen Topf-Konflikt
// @desc    Führt das Höchstpreisverfahren für einen EINZELNEN Topf-Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/hoechstpreis-ergebnis
router.put('/:konfliktId/hoechstpreis-ergebnis', konfliktController.verarbeiteHoechstpreisErgebnis);

// Phase 3: Höchstpreis-Ergebnis für einen Slot-Konflikt
// @desc    Führt das Höchstpreisverfahren für einen EINZELNEN Slot-Konflikt durch
// @route   PUT /api/konflikte/slot/:konfliktId/hoechstpreis-ergebnis
router.put('/slot/:konfliktId/hoechstpreis-ergebnis', konfliktController.verarbeiteEinzelSlotHoechstpreisErgebnis);


// ROUTE für die Detail- und Bearbeitungsseite einer Gruppe
// @route   GET /api/konflikte/gruppen/:gruppenId
router.get('/gruppen/:gruppenId', konfliktController.getKonfliktGruppeById);

// ROUTEN für die phasenweise GRUPPEN-Konfliktlösung

// Phase 1: Verzicht und Verschub für eine Gruppe von Topf-Konflikten
// @route   PUT /api/konflikte/gruppen/:gruppenId/verzicht-verschub
// @desc    Phase 1: Verarbeitet Verzichte/Verschiebungen für eine ganze Konfliktgruppe von Topf-Konflikten
// @access  Admin/System
router.put('/gruppen/:gruppenId/verzicht-verschub', konfliktController.verarbeiteGruppenVerzichtVerschub);


// Phase 1: Verzicht und Verschub für eine Gruppe von Slot-Konflikten
// @route   PUT /api/konflikte/slot-gruppen/:gruppenId/verzicht-verschub
// @desc    Phase 1: Verarbeitet Verzichte/Verschiebungen für eine ganze Konfliktgruppe von Slot-Konflikten
router.put('/slot-gruppen/:gruppenId/verzicht-verschub', konfliktController.verarbeiteSlotGruppenVerzichtVerschub);



// ROUTE für Gruppen-Entgeltvergleich (Töpfe)
// Phase 2: Entgeltvergleich für eine Gruppe identischer Topf-Konflikte
// @route   PUT /api/konflikte/gruppen/:gruppenId/entgeltvergleich
// @desc    Phase 2: Führt Entgeltvergleich zur Konfliktlösung für eine ganze Topf-Konfliktgruppe durch
// @access  Admin/System
router.put('/gruppen/:gruppenId/entgeltvergleich', konfliktController.fuehreGruppenEntgeltvergleichDurch);

// ROUTE für Gruppen-Entgeltvergleich (Slots)
// Phase 2: Entgeltvergleich für eine Gruppe identischer Slot-Konflikte
// @route   PUT /api/konflikte/slot-gruppen/:gruppenId/entgeltvergleich
// @desc    Phase 2: Führt Entgeltvergleich zur Konfliktlösung für eine ganze Slot-Konfliktgruppe durch
router.put('/slot-gruppen/:gruppenId/entgeltvergleich', konfliktController.fuehreSlotGruppenEntgeltvergleichDurch);


// ROUTE für Gruppen-Höchstpreisverfahren (Töpfe)
// Phase 3: Höchstpreisverfahren für eine Gruppe identischer Topf-Konflikte
// @route   PUT /api/konflikte/gruppen/:gruppenId/hoechstpreis-ergebnis
// @desc    Phase 3: Führt Höchstpreisverfahren zur Konfliktlösung für eine ganze Topf-Konfliktgruppe durch
// @access  Admin/System
router.put('/gruppen/:gruppenId/hoechstpreis-ergebnis', konfliktController.verarbeiteGruppenHoechstpreisErgebnis);

// ROUTE für Gruppen-Höchstpreisverfahren (Slots)
// Phase 3: Höchstpreisverfahren für eine Gruppe identischer Slot-Konflikte
// @route   PUT /api/konflikte/slot-gruppen/:gruppenId/hoechstpreis-ergebnis
// @desc    Phase 3: Führt Höchstpreisverfahren zur Konfliktlösung für eine ganze Slot-Konfliktgruppe durch
router.put('/slot-gruppen/:gruppenId/hoechstpreis-ergebnis', konfliktController.verarbeiteSlotGruppenHoechstpreisErgebnis);


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

// ROUTE zum Zurücksetzen einer Konfliktgruppe
// @route   POST /api/konflikte/gruppen/:gruppenId/reset
// @desc    Löscht eine Konfliktgruppe und deren Dokumente und setzt die betroffenen Anfragen zurück
// @access  Admin/System
router.post('/gruppen/:gruppenId/reset', konfliktController.resetKonfliktGruppe);



module.exports = router;