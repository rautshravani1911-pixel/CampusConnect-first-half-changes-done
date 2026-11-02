const { Announcement, Club, ClubCoordinator } = require('../models');

const getAnnouncements = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { count, rows: announcements } = await Announcement.findAndCountAll({
      limit,
      offset,
      include: {
        model: Club,
        attributes: ['name', 'logo_url']
      },
      order: [['is_important', 'DESC'], ['created_at', 'DESC']]
    });

    res.json({
      announcements,
      pagination: {
        total: count,
        page,
        limit,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ message: 'Server error fetching announcements' });
  }
};

const createAnnouncement = async (req, res) => {
  const { title, content, category, is_important, club_id } = req.body;

  try {
    if (!title || !title.trim() || !content || !content.trim()) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    // Role-based club ownership check
    if (req.user.role !== 'admin') {
      if (!club_id) {
        return res.status(403).json({
          message: 'Forbidden: Coordinators can only create announcements for their assigned club'
        });
      }

      const club = await Club.findByPk(club_id);
      if (!club) {
        return res.status(404).json({ message: 'Club not found' });
      }

      const coord = await ClubCoordinator.findOne({
        where: { user_id: req.user.id, club_id }
      });
      if (!coord) {
        return res.status(403).json({
          message: 'Forbidden: You are not a coordinator for this club'
        });
      }
    } else if (club_id) {
      const club = await Club.findByPk(club_id);
      if (!club) {
        return res.status(404).json({ message: 'Club not found' });
      }
    }

    const announcement = await Announcement.create({
      title: title.trim(),
      content: content.trim(),
      category: category || (club_id ? 'club' : 'general'),
      is_important: is_important || false,
      club_id: club_id || null
    });

    res.status(201).json(announcement);
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ message: 'Server error creating announcement' });
  }
};

module.exports = { getAnnouncements, createAnnouncement };
