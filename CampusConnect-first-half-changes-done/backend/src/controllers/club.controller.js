const { Op } = require('sequelize');
const {
  Club,
  ClubRegistration,
  Student,
  User,
  ClubMember,
  ClubCoordinator,
  Announcement,
  Event,
  Achievement
} = require('../models');

const getClubs = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const offset = (page - 1) * limit;

    const { category, search, registration_status } = req.query;

    const whereClause = {};

    if (category) {
      whereClause.category = category;
    }

    if (registration_status) {
      whereClause.registration_status = registration_status;
    }

    if (search) {
      whereClause.name = { [Op.iLike]: `%${search}%` };
    }

    const { count, rows: clubs } = await Club.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      order: [['name', 'ASC']]
    });

    res.json({
      clubs,
      pagination: {
        total: count,
        page,
        limit,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching clubs:', error);
    res.status(500).json({ message: 'Server error fetching clubs' });
  }
};

const getClubById = async (req, res) => {
  const { id } = req.params;

  try {
    const club = await Club.findByPk(id, {
      include: [
        {
          model: ClubCoordinator,
          include: { model: User, attributes: ['name', 'email'] }
        },
        {
          model: ClubMember,
          include: {
            model: Student,
            include: { model: User, attributes: ['name'] }
          }
        },
        {
          model: Announcement,
          limit: 5,
          order: [['created_at', 'DESC']]
        },
        {
          model: Event,
          limit: 5,
          order: [['event_date', 'ASC']]
        },
        {
          model: Achievement,
          order: [['date', 'DESC']]
        }
      ]
    });

    if (!club) {
      return res.status(404).json({ message: 'Club not found' });
    }

    res.json(club);
  } catch (error) {
    console.error('Error fetching club details:', error);
    res.status(500).json({ message: 'Server error fetching club details' });
  }
};

const registerForClub = async (req, res) => {
  const { id: clubId } = req.params;
  const { skills, experience, statement_of_purpose, availability } = req.body;

  try {
    const student = await Student.findOne({ where: { user_id: req.user.id } });
    if (!student) {
      return res.status(404).json({ message: 'Student profile not found. Complete your profile first.' });
    }

    // Check if club exists
    const club = await Club.findByPk(clubId);
    if (!club) {
      return res.status(404).json({ message: 'Club not found' });
    }

    // Check registration status
    if (club.registration_status !== 'open') {
      return res.status(400).json({ message: 'Club registrations are currently closed' });
    }

    // Check registration date window (start and deadline)
    const now = new Date();
    if (club.registration_start && now < new Date(club.registration_start)) {
      return res.status(400).json({ message: 'Club registrations have not started yet' });
    }

    if (club.registration_end && now > new Date(club.registration_end)) {
      return res.status(400).json({ message: 'Club registration deadline has passed' });
    }

    // Check if student is already a member of this club
    const existingMember = await ClubMember.findOne({
      where: {
        student_id: student.id,
        club_id: clubId
      }
    });

    if (existingMember) {
      return res.status(400).json({ message: 'You are already a member of this club' });
    }

    // Check if student has already applied
    const existingReg = await ClubRegistration.findOne({
      where: {
        student_id: student.id,
        club_id: clubId
      }
    });

    if (existingReg) {
      return res.status(400).json({ message: 'You have already applied to this club' });
    }

    // Check club max members capacity
    if (club.max_members) {
      const currentMemberCount = await ClubMember.count({ where: { club_id: clubId } });
      if (currentMemberCount >= club.max_members) {
        return res.status(400).json({ message: 'Club has reached its maximum member capacity' });
      }
    }

    const registration = await ClubRegistration.create({
      student_id: student.id,
      club_id: clubId,
      skills,
      experience,
      statement_of_purpose,
      availability,
      status: 'pending'
    });

    res.status(201).json({
      message: 'Application submitted successfully',
      applicationId: registration.id,
      status: registration.status
    });
  } catch (error) {
    console.error('Error applying to club:', error);
    res.status(500).json({ message: 'Server error registering for club' });
  }
};

const getStudentRegistrations = async (req, res) => {
  try {
    const student = await Student.findOne({ where: { user_id: req.user.id } });
    if (!student) {
      return res.json([]);
    }

    const registrations = await ClubRegistration.findAll({
      where: { student_id: student.id },
      include: {
        model: Club,
        attributes: ['name', 'logo_url', 'category']
      },
      order: [['applied_date', 'DESC']]
    });

    res.json(registrations);
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ message: 'Server error fetching registrations' });
  }
};

module.exports = {
  getClubs,
  getClubById,
  registerForClub,
  getStudentRegistrations
};
