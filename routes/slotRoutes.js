// slot-buchungs-app/routes/slotRoutes.js
const express = require('express');
const router = express.Router();
const slotController = require('../controllers/slotController'); // Erstellen wir als Nächstes

// @route   POST /api/slots
// @desc    Erstellt einen neuen Infrastruktur-Slot
// @access  Admin (angenommen, später mit Autorisierung)
router.post('/', slotController.createSlot);

// ROUTE für die Massenerstellung
// @route   POST /api/slots/massen-erstellung
// @desc    Erstellt mehrere Slots basierend auf einem Muster und einem Zeitraum
// @access  Admin (angenommen)
router.post('/massen-erstellung', slotController.createSlotsBulk);

// ROUTE für die statistische Zusammenfassung der Slots
// @route   GET /api/slots/summary
// @desc    Liefert eine aggregierte Zusammenfassung aller Slots
// @access  Admin (angenommen)
router.get('/summary', slotController.getSlotSummary);

// ROUTE für die Slot-Zusammenfassung nach Abschnitt
// @route   GET /api/slots/counter
// @desc    Liefert eine aggregierte Zusammenfassung von Slots nach Abschnitt und Verkehrstagen
router.get('/counter', slotController.getSlotCounterSummary);

// @route   GET /api/slots
// @desc    Ruft alle Slots ab (mit Filter- und Sortiermöglichkeiten)
// @access  Public/Admin
router.get('/', slotController.getAllSlots);

// @route   GET /api/slots/:slotId
// @desc    Ruft einen einzelnen Slot anhand seiner ID (_id oder SlotID_Sprechend) ab
// @access  Public/Admin
router.get('/:slotId', slotController.getSlotById);

// NEUE ROUTE für die spezielle Abfrage
// @route   GET /api/slots/konflikt-alternativen
// @desc    Sucht freie Slots für die Konfliktlösung basierend auf spezifischen Kriterien
// @access  Admin/System (angenommen)
router.get('/konflikt-alternativen', slotController.getKonfliktAlternativenSlots);

// @route   PUT /api/slots/:slotId
// @desc    Aktualisiert einen bestehenden Slot
// @access  Admin (angenommen)
router.put('/:slotId', slotController.updateSlot); // <-- NEU HINZUGEFÜGT

// @route   DELETE /api/slots/:slotId
// @desc    Löscht einen Slot
// @access  Admin (angenommen)
router.delete('/:slotId', slotController.deleteSlot); // <-- NEU HINZUGEFÜGT

module.exports = router;