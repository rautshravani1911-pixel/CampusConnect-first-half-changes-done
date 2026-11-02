const { Op } = require('sequelize');
const { Event, EventRegistration, Student, User, Club, EventGallery, ClubCoordinator } = require('../models');

const getEvents = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { tab, search } = req.query;
    const today = new Date();
    const whereClause = {};

    if (search) {
      whereClause.title = { [Op.iLike]: `%${search}%` };
    }

    if (tab === 'this_week') {
      const nextWeek = new Date();
      nextWeek.setDate(today.getDate() + 7);
      whereClause.event_date = { [Op.between]: [today, nextWeek] };
    } else if (tab === 'this_month') {
      const nextMonth = new Date();
      nextMonth.setMonth(today.getMonth() + 1);
      whereClause.event_date = { [Op.between]: [today, nextMonth] };
    } else if (tab === 'completed') {
      whereClause.event_date = { [Op.lt]: today };
    } else if (tab === 'upcoming' || !tab) {
      whereClause.event_date = { [Op.gte]: today };
    }

    const { count, rows: events } = await Event.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      include: {
        model: Club,
        attributes: ['name', 'logo_url']
      },
      order: [['event_date', 'ASC']]
    });

    res.json({
      events,
      pagination: {
        total: count,
        page,
        limit,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ message: 'Server error fetching events' });
  }
};

const getEventById = async (req, res) => {
  const { id } = req.params;

  try {
    const event = await Event.findByPk(id, {
      include: [
        { model: Club, attributes: ['name', 'logo_url'] },
        { model: EventGallery }
      ]
    });

    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }

    res.json(event);
  } catch (error) {
    console.error('Error fetching event details:', error);
    res.status(500).json({ message: 'Server error fetching event details' });
  }
};

const registerForEvent = async (req, res) => {
  const { id: eventId } = req.params;

  try {
    const student = await Student.findOne({ where: { user_id: req.user.id } });
    if (!student) {
      return res.status(404).json({ message: 'Student profile not found. Register first.' });
    }

    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }

    // Check deadline
    if (new Date() > new Date(event.registration_deadline)) {
      return res.status(400).json({ message: 'Registration deadline has passed' });
    }

    // Check duplicate
    const existingReg = await EventRegistration.findOne({
      where: {
        student_id: student.id,
        event_id: eventId
      }
    });

    if (existingReg) {
      return res.status(400).json({ message: 'You are already registered for this event' });
    }

    // Check max participants
    if (event.max_participants) {
      const regCount = await EventRegistration.count({ where: { event_id: eventId } });
      if (regCount >= event.max_participants) {
        return res.status(400).json({ message: 'Event registrations are full' });
      }
    }

    const registration = await EventRegistration.create({
      student_id: student.id,
      event_id: eventId,
      status: 'registered'
    });

    res.status(201).json({
      message: 'Successfully registered for event',
      registrationId: registration.id
    });
  } catch (error) {
    console.error('Error registering for event:', error);
    res.status(500).json({ message: 'Server error registering for event' });
  }
};

const getRegisteredEvents = async (req, res) => {
  try {
    const student = await Student.findOne({ where: { user_id: req.user.id } });
    if (!student) {
      return res.json([]);
    }

    const registrations = await EventRegistration.findAll({
      where: { student_id: student.id },
      include: {
        model: Event,
        include: { model: Club, attributes: ['name', 'logo_url'] }
      },
      order: [[Event, 'event_date', 'ASC']]
    });

    res.json(registrations.map(r => ({
      ...r.Event.toJSON(),
      registration_id: r.id,
      ticket_token: r.ticket_token,
      attendance_status: r.status,
      attended_at: r.attended_at
    })));
  } catch (error) {
    console.error('Error fetching registered events:', error);
    res.status(500).json({ message: 'Server error fetching registered events' });
  }
};

// Verify student QR code / ticket token to mark attendance
const verifyAttendance = async (req, res) => {
  const { id: eventId } = req.params;
  const { ticket_token } = req.body;

  try {
    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    if (req.user.role !== 'admin') {
      const coord = await ClubCoordinator.findOne({
        where: { user_id: req.user.id, club_id: event.club_id }
      });
      if (!coord) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You are not a coordinator for this event\'s club.'
        });
      }
    }

    if (!ticket_token) {
      return res.status(400).json({ success: false, message: 'Ticket token is required.' });
    }

    const registration = await EventRegistration.findOne({
      where: {
        event_id: eventId,
        ticket_token
      },
      include: [
        {
          model: Student,
          include: [{ model: User, attributes: ['id', 'name', 'email'] }]
        },
        {
          model: Event,
          include: [{ model: Club, attributes: ['id', 'name'] }]
        }
      ]
    });

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'Invalid ticket! No matching registration found for this event.'
      });
    }

    if (registration.status === 'attended') {
      return res.status(200).json({
        success: true,
        already_verified: true,
        message: `Student ${registration.Student.User.name} is ALREADY marked as attended at ${new Date(registration.attended_at).toLocaleTimeString()}.`,
        registration
      });
    }

    registration.status = 'attended';
    registration.attended_at = new Date();
    await registration.save();

    res.json({
      success: true,
      already_verified: false,
      message: `Attendance verified! Welcome, ${registration.Student.User.name}.`,
      registration
    });
  } catch (error) {
    console.error('Error verifying attendance:', error);
    res.status(500).json({ success: false, message: 'Server error verifying attendance' });
  }
};

// Get all attendees for an event (Coordinator / Admin view)
const getEventAttendees = async (req, res) => {
  const { id: eventId } = req.params;

  try {
    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    if (req.user.role !== 'admin') {
      const coord = await ClubCoordinator.findOne({
        where: { user_id: req.user.id, club_id: event.club_id }
      });
      if (!coord) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You are not a coordinator for this event\'s club.'
        });
      }
    }

    const attendees = await EventRegistration.findAll({
      where: { event_id: eventId },
      include: [
        {
          model: Student,
          include: [{ model: User, attributes: ['id', 'name', 'email'] }]
        }
      ],
      order: [['registered_at', 'ASC']]
    });

    res.json({
      success: true,
      total_registered: attendees.length,
      total_attended: attendees.filter(a => a.status === 'attended').length,
      attendees
    });
  } catch (error) {
    console.error('Error fetching event attendees:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch attendees' });
  }
};

module.exports = {
  getEvents,
  getEventById,
  registerForEvent,
  getRegisteredEvents,
  verifyAttendance,
  getEventAttendees
};
