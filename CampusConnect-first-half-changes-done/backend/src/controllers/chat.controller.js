const { Op } = require('sequelize');
const { Message, User, Club, ClubMember, ClubCoordinator, Student } = require('../models');
const { sendNotificationToUser, emitNewMessage } = require('../sockets/socket.handler');

// Get all active 1-on-1 conversations for the logged-in user
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all direct messages involving this user
    const messages = await Message.findAll({
      where: {
        message_type: 'direct',
        [Op.or]: [
          { sender_id: userId },
          { receiver_id: userId }
        ]
      },
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'name', 'email', 'role']
        },
        {
          model: User,
          as: 'receiver',
          attributes: ['id', 'name', 'email', 'role']
        }
      ],
      order: [['created_at', 'DESC']]
    });

    // Group by conversation partner
    const conversationsMap = new Map();

    for (const msg of messages) {
      const isSender = msg.sender_id === userId;
      const partner = isSender ? msg.receiver : msg.sender;
      if (!partner) continue;

      if (!conversationsMap.has(partner.id)) {
        conversationsMap.set(partner.id, {
          user: partner,
          lastMessage: {
            id: msg.id,
            content: msg.content,
            created_at: msg.created_at,
            sender_id: msg.sender_id,
            read_at: msg.read_at
          },
          unreadCount: (!isSender && !msg.read_at) ? 1 : 0
        });
      } else if (!isSender && !msg.read_at) {
        conversationsMap.get(partner.id).unreadCount += 1;
      }
    }

    res.json({
      success: true,
      conversations: Array.from(conversationsMap.values())
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch conversations.' });
  }
};

// Get direct messages with a specific user
exports.getDirectMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { recipientId } = req.params;

    // Verify recipient exists
    const recipient = await User.findByPk(recipientId, {
      attributes: ['id', 'name', 'email', 'role']
    });

    if (!recipient) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Mark unread messages as read
    await Message.update(
      { read_at: new Date() },
      {
        where: {
          sender_id: recipientId,
          receiver_id: userId,
          read_at: null,
          message_type: 'direct'
        }
      }
    );

    const messages = await Message.findAll({
      where: {
        message_type: 'direct',
        [Op.or]: [
          { sender_id: userId, receiver_id: recipientId },
          { sender_id: recipientId, receiver_id: userId }
        ]
      },
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'name', 'email', 'role']
        }
      ],
      order: [['created_at', 'ASC']]
    });

    res.json({
      success: true,
      recipient,
      messages
    });
  } catch (error) {
    console.error('Error fetching direct messages:', error);
    res.status(500).json({ success: false, message: 'Failed to load messages.' });
  }
};

// Helper to check if a user has access to a club's channel (Admin, assigned Club Coordinator, or active Club Member)
const checkClubAccess = async (userId, userRole, clubId) => {
  if (userRole === 'admin') return true;

  if (userRole === 'coordinator') {
    const coord = await ClubCoordinator.findOne({
      where: { user_id: userId, club_id: clubId }
    });
    return !!coord;
  }

  if (userRole === 'student') {
    const student = await Student.findOne({ where: { user_id: userId } });
    if (student) {
      const member = await ClubMember.findOne({
        where: { student_id: student.id, club_id: clubId }
      });
      return !!member;
    }
  }

  return false;
};

// Get club channel messages
exports.getClubMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { clubId } = req.params;

    const club = await Club.findByPk(clubId, {
      attributes: ['id', 'name', 'category', 'logo_url']
    });

    if (!club) {
      return res.status(404).json({ success: false, message: 'Club not found.' });
    }

    // Verify access: Admin, Coordinator of this club, or active Club Member
    const hasAccess = await checkClubAccess(userId, req.user.role, clubId);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'You must be an accepted member or coordinator of this club to view the channel.'
      });
    }

    const messages = await Message.findAll({
      where: {
        club_id: clubId,
        message_type: 'club_channel'
      },
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'name', 'email', 'role']
        }
      ],
      order: [['created_at', 'ASC']],
      limit: 100
    });

    res.json({
      success: true,
      club,
      messages
    });
  } catch (error) {
    console.error('Error fetching club messages:', error);
    res.status(500).json({ success: false, message: 'Failed to load club channel messages.' });
  }
};

// Send a message (Direct or Club Channel)
exports.sendMessage = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiver_id, club_id, content, message_type = 'direct' } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: 'Message content cannot be empty.' });
    }

    if (message_type === 'direct') {
      if (!receiver_id) {
        return res.status(400).json({ success: false, message: 'Recipient is required for direct messages.' });
      }

      const recipient = await User.findByPk(receiver_id);
      if (!recipient) {
        return res.status(404).json({ success: false, message: 'Recipient user not found.' });
      }
    }

    if (message_type === 'club_channel') {
      if (!club_id) {
        return res.status(400).json({ success: false, message: 'Club ID is required for club channel messages.' });
      }

      const club = await Club.findByPk(club_id);
      if (!club) {
        return res.status(404).json({ success: false, message: 'Club not found.' });
      }

      // Verify access: Admin, Coordinator of this club, or active Club Member
      const hasAccess = await checkClubAccess(senderId, req.user.role, club_id);
      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          message: 'You must be an accepted member or coordinator of this club to post in the channel.'
        });
      }
    }

    const newMessage = await Message.create({
      sender_id: senderId,
      receiver_id: message_type === 'direct' ? receiver_id : null,
      club_id: message_type === 'club_channel' ? club_id : null,
      content: content.trim(),
      message_type
    });

    const populatedMessage = await Message.findByPk(newMessage.id, {
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'name', 'email', 'role']
        }
      ]
    });

    // Emit real-time WebSocket event to receiver or club room
    emitNewMessage(populatedMessage);

    // If direct message, also send persistent push notification alert
    if (message_type === 'direct') {
      sendNotificationToUser(receiver_id, {
        type: 'new_chat_message',
        title: `Message from ${req.user.name}`,
        message: content.length > 60 ? `${content.substring(0, 57)}...` : content,
        data: { sender_id: senderId }
      });
    }

    res.status(201).json({
      success: true,
      message: populatedMessage
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
};
