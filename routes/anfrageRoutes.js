// slot-buchungs-app/routes/anfrageRoutes.js
const express = require('express');
const router = express.Router();
const anfrageController = require('../controllers/anfrageController');

// @route   POST /api/anfragen
// @desc    Erstellt eine neue Trassenanfrage
// @access  Public
router.post('/', anfrageController.createAnfrage);

// @route   POST /api/anfragen/:anfrageId/zuordnen
// @desc    Funktion sucht die passenden Slots der Anfrage heraus und belegt sie mit Konflikt
// @access  Public
router.post('/:anfrageId/zuordnen', anfrageController.zuordneSlotsZuAnfrage);

// @route   GET /api/anfragen
// @desc    Ruft alle Anfragen ab (mit Filter- und Sortiermöglichkeiten)
// @access  Public
router.get('/', anfrageController.getAllAnfragen);

// @route   GET /api/anfragen/:anfrageId
// @desc    Ruft eine einzelne Anfrage anhand ihrer ID (_id oder AnfrageID_Sprechend) ab
// @access  Public (später ggf. anpassen)
router.get('/:anfrageId', anfrageController.getAnfrageById); // <-- NEU HINZUGEFÜGT

// @route   PUT /api/anfragen/:anfrageId
// @desc    Aktualisiert eine bestehende Anfrage (z.B. zur Korrektur)
// @access  Public (später ggf. anpassen)
router.put('/:anfrageId', anfrageController.updateAnfrage); // <-- NEU HINZUGEFÜGT



module.exports = router;