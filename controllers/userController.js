const mongoose = require('mongoose');
const User = require('../models/User');
const Interest = require('../models/Interest');
const Message = require('../models/Message');
const ProfileView = require('../models/ProfileView');
const Shortlist = require('../models/Shortlist');
const Notification = require('../models/Notification');
const Ignore = require('../models/Ignore');
const Announcement = require('../models/Announcement');

// @desc    Send a message
// @route   POST /api/users/message
exports.sendMessage = async (req, res) => {
    try {
        const { receiverId, text } = req.body;
        
        // Check if interest is accepted first
        const acceptedInterest = await Interest.findOne({
            $or: [
                { sender: req.user.id, receiver: receiverId, status: 'accepted' },
                { sender: receiverId, receiver: req.user.id, status: 'accepted' }
            ]
        });

        if (!acceptedInterest || !acceptedInterest.isAdminApproved) {
            return res.status(403).json({ 
                success: false, 
                message: 'Alliances must be verified by our curators before communication is enabled. Please wait for admin confirmation.' 
            });
        }

        const message = await Message.create({
            sender: req.user.id,
            receiver: receiverId,
            content: text
        });

        // Create Notification
        await Notification.create({
            receiver: receiverId,
            sender: req.user.id,
            type: 'message'
        });

        const io = req.app.get('socketio');
        if (io) {
            io.to(receiverId).emit('message received', {
                ...message.toObject(),
                senderName: req.user.name || 'Member'
            });
            io.to(receiverId).emit('notification', {
                message: `New message from ${req.user.name || 'a member'}`,
                type: 'message'
            });
        }

        res.status(201).json({ success: true, data: message });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Centralized Privacy Filter for Heritage Dossiers
 * @rule    Photos and personal dossiers are LOCKED until Mutual Interest + Admin Approval
 */
const maskUserForPrivacy = (targetUser, viewerId, isAdmin, connection) => {
    const userObj = targetUser.toObject ? targetUser.toObject() : targetUser;
    const isOwner = viewerId && userObj._id.toString() === viewerId.toString();
    const isApproved = connection && connection.status === 'accepted' && connection.isAdminApproved;
    
    // Step 2: Connection Metadata (Non-Sensitive)
    const statusMetadata = {
        isEstablished: connection && connection.status === 'accepted',
        isAdminApproved: connection && connection.isAdminApproved,
        hasMutualInterest: connection && connection.status === 'accepted',
        isPending: connection && connection.status === 'pending'
    };

    if (isOwner || isAdmin || isApproved) {
        return { ...userObj, connectionStatus: statusMetadata };
    }

    const canSeeFullDossier = statusMetadata.isEstablished && statusMetadata.isAdminApproved;

    // Heritage Archive Curation (Masking)
    return {
        _id: userObj._id,
        profileId: userObj.profileId || 'MM-XXXXX',
        matchScore: userObj.matchScore,
        connectionStatus: statusMetadata,
        basicInfo: userObj.basicInfo, // Name and Age always safe for discovery
        personalDetails: canSeeFullDossier ? userObj.personalDetails : {
            education: userObj.personalDetails?.education?.split(' ')[0] || 'Professional',
            occupation: 'Protected', 
            aboutSelf: "Dossier under heritage protection until alliance proposed.",
            caste: userObj.personalDetails?.caste ? (userObj.personalDetails.caste.substring(0, 3) + '...') : 'Protected'
        },
        contactInfo: {
            location: canSeeFullDossier ? userObj.contactInfo?.location : 'City Protected'
        },
        status: {
            isVerified: userObj.status?.isVerified,
            isPremium: userObj.status?.isPremium
        },
        profilePhotos: canSeeFullDossier ? userObj.profilePhotos : [], 
        profileImage: canSeeFullDossier ? userObj.profileImage : '',
        partnerPreferences: canSeeFullDossier ? userObj.partnerPreferences : {}, 
        hasSentInterest: userObj.hasSentInterest,
        isShortlisted: userObj.isShortlisted
    };
};

/**
 * @desc    Centripetal Alignment Intelligence
 * @logic   Calculates compatibility based on lineage, academic pedigree, and location
 */
const calculateMatchScore = (targetUser, currentUser) => {
    let score = 30; // Base baseline
    if (targetUser.personalDetails?.caste && currentUser.personalDetails?.caste) {
        if (targetUser.personalDetails.caste.toLowerCase() === currentUser.personalDetails.caste.toLowerCase()) {
            score += 40;
        }
    }
    if (targetUser.contactInfo?.location?.city && currentUser.contactInfo?.location?.city) {
        if (targetUser.contactInfo.location.city === currentUser.contactInfo.location.city) {
            score += 15;
        }
    }
    if (targetUser.personalDetails?.education && currentUser.personalDetails?.education) {
        const uE = currentUser.personalDetails.education.toLowerCase();
        const tE = targetUser.personalDetails.education.toLowerCase();
        if ((uE.includes('eng') && tE.includes('eng')) || (uE.includes('doc') && tE.includes('doc')) || (uE.includes('mba') && tE.includes('mba'))) {
            score += 10;
        }
    }
    if (targetUser.basicInfo?.religion && currentUser.basicInfo?.religion) {
        if (targetUser.basicInfo.religion === currentUser.basicInfo.religion) {
            score += 5;
        }
    }
    return Math.min(99, score);
};

// @desc    Get messages with a specific user
// @route   GET /api/users/messages/:id
exports.getMessages = async (req, res) => {
    try {
        const messages = await Message.find({
            $or: [
                { sender: req.user.id, receiver: req.params.id },
                { sender: req.params.id, receiver: req.user.id }
            ]
        }).sort({ createdAt: 1 });

        res.json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.respondToInterest = async (req, res) => {
    try {
        const { status } = req.body;
        const user = await User.findById(req.user.id);
        
        if (!user.status.isPremium && status === 'accepted') {
            return res.status(403).json({ 
                success: false, 
                message: 'Alliances can only be established by Premium Members. Please upgrade your dossier status to connect.' 
            });
        }

        const interest = await Interest.findById(req.params.id);
        if (!interest) return res.status(404).json({ success: false });
        interest.status = status;
        await interest.save();

        if (status === 'accepted') {
            await Notification.create({
                receiver: interest.sender,
                sender: req.user.id,
                type: 'accept'
            });

            const io = req.app.get('socketio');
            if (io) {
                io.to(interest.sender.toString()).emit('notification', {
                    message: `${req.user.name || 'A member'} accepted your interest!`,
                    type: 'accept'
                });
            }
        }

        res.json({ success: true, data: interest });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getDashboardData = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const stats = {
            interestsReceived: await Interest.countDocuments({ receiver: req.user.id }),
            messagesReceived: await Message.countDocuments({ receiver: req.user.id, isRead: false }),
            profileViews: await ProfileView.countDocuments({ profile: req.user.id }),
            shortlistedBy: await Shortlist.countDocuments({ receiver: req.user.id })
        };
        const oppositeGender = user.basicInfo.gender === 'Male' ? 'Female' : 'Male';
        
        const ignored = await Ignore.find({ sender: req.user.id });
        const ignoredIds = ignored.map(i => i.receiver);
        
        const baseQuery = { 
            _id: { $ne: req.user.id, $nin: ignoredIds }, 
            'basicInfo.gender': oppositeGender,
            'status.role': { $nin: ['Admin', 'admin'] } 
        };

        const prefs = user.partnerPreferences;
        let prefQuery = { ...baseQuery };
        if (prefs) {
            if (prefs.ageRange?.min || prefs.ageRange?.max) {
                prefQuery['basicInfo.age'] = { 
                    $gte: prefs.ageRange.min || 18, 
                    $lte: prefs.ageRange.max || 100 
                };
            }
            if (prefs.religion?.length > 0) prefQuery['basicInfo.religion'] = { $in: prefs.religion };
        }

        const recommendationsRaw = {
            dailyMatches: await User.find(baseQuery).limit(8).sort({ createdAt: -1 }),
            preferenceMatches: await User.find(prefQuery).limit(8).sort({ createdAt: -1 }),
            newMembers: await User.find(baseQuery).limit(8).sort({ createdAt: -1 }),
            nearMe: await User.find({ ...baseQuery, 'contactInfo.location.city': user.contactInfo.location.city }).limit(8)
        };

        const myInterests = await Interest.find({ 
            $or: [{ sender: req.user.id }, { receiver: req.user.id }] 
        });

        // Heritage Assets for Atelier Design System
        const heritageAssets = {
            watermark: '/assets/madurai_heritage_sketch.png',
            background: '/assets/temple_stone_texture.png',
            theme: 'Atelier_Madurai_Lux'
        };

        const filterUser = (userList) => userList.map(u => {
            const connection = myInterests.find(i => 
                (i.sender.toString() === req.user.id.toString() && i.receiver.toString() === u._id.toString()) ||
                (i.sender.toString() === u._id.toString() && i.receiver.toString() === req.user.id.toString())
            );
            
            const userWithScore = u.toObject();
            userWithScore.matchScore = calculateMatchScore(userWithScore, user);
            
            return maskUserForPrivacy(userWithScore, req.user.id, false, connection);
        });

        const recommendations = {
            dailyMatches: filterUser(recommendationsRaw.dailyMatches),
            preferenceMatches: filterUser(recommendationsRaw.preferenceMatches),
            newMembers: filterUser(recommendationsRaw.newMembers),
            nearMe: filterUser(recommendationsRaw.nearMe)
        };

        const recentInterests = await Interest.find({ receiver: req.user.id })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('sender', 'basicInfo profilePhotos');
            
        // Use user.id for profile stats
        const recentViews = await ProfileView.find({ profile: req.user.id })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('viewer', 'basicInfo profilePhotos');

        const activities = [
            ...recentInterests.map(i => ({
                id: i._id,
                type: 'interest',
                user: i.sender,
                text: 'expressed interest in your profile.',
                date: i.createdAt
            })),
            ...recentViews.map(v => ({
                id: v._id,
                type: 'view',
                user: v.viewer,
                text: 'viewed your profile gallery.',
                date: v.createdAt
            }))
        ].sort((a, b) => b.date - a.date).slice(0, 5);

        res.json({ success: true, user, stats, recommendations, activities, heritageAssets });
    } catch (error) { 
        console.error('[ARCHIVE ERROR] Dashboard Logic Breakdown:', error);
        res.status(500).json({ success: false, message: error.message }); 
    }
};

exports.getMatches = async (req, res) => {
    try {
        const { ageMin, ageMax, religion, caste, city, education, maritalStatus, tab, subFilter } = req.query;
        console.log(`[ARCHIVE DISCOVERY] Querying matches for User: ${req.user.id} - Params:`, req.query);
        
        const currentUser = await User.findById(req.user.id);
        if (!currentUser) {
            console.error('[ARCHIVE ERROR] Requesting user not found in registry');
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const oppositeGender = currentUser.basicInfo.gender === 'Male' ? 'Female' : 'Male';

        const ignored = await Ignore.find({ sender: req.user.id });
        const ignoredIds = ignored.map(i => i.receiver);

        let query = { 
            _id: { $ne: req.user.id, $nin: ignoredIds }, 
            'basicInfo.gender': oppositeGender,
            'status.role': { $nin: ['Admin', 'admin'] }
        };

        if (ageMin || ageMax) {
            query['basicInfo.age'] = { 
                $gte: parseInt(ageMin) || 18, 
                $lte: parseInt(ageMax) || 100 
            };
        }
        if (religion) query['basicInfo.religion'] = religion;
        if (maritalStatus) query['basicInfo.maritalStatus'] = maritalStatus;
        if (caste) query['personalDetails.caste'] = { $regex: caste, $options: 'i' };
        if (city) query['contactInfo.location.city'] = { $regex: city, $options: 'i' };
        if (education) query['personalDetails.education'] = { $regex: education, $options: 'i' };

        if (tab === 'new') {
            const lastWeek = new Date();
            lastWeek.setDate(lastWeek.getDate() - 7);
            query.createdAt = { $gte: lastWeek };
        } else if (tab === 'shortlist') {
            const shortlists = await Shortlist.find({ sender: req.user.id });
            const peerIds = shortlists.map(s => s.receiver);
            query._id = { $in: peerIds };
        }

        if (subFilter === 'with_photo') {
            query.profilePhotos = { $exists: true, $not: { $size: 0 } };
        } else if (subFilter === 'premium') {
            query['status.isPremium'] = true;
        }

        const matchesRaw = await User.find(query).limit(50).sort({ createdAt: -1 });
        const myInterests = await Interest.find({ 
            $or: [{ sender: req.user.id }, { receiver: req.user.id }] 
        });
        const myShortlists = await Shortlist.find({ sender: req.user.id });

        const matches = matchesRaw.map(user => {
            const connection = myInterests.find(i => 
                (i.sender.toString() === req.user.id.toString() && i.receiver.toString() === user._id.toString()) ||
                (i.sender.toString() === user._id.toString() && i.receiver.toString() === req.user.id.toString())
            );

            const userObj = user.toObject();
            userObj.hasSentInterest = !!(connection && connection.sender.toString() === req.user.id.toString());
            userObj.isShortlisted = myShortlists.some(s => s.receiver.toString() === userObj._id.toString());
            
            // Inject Alignment Score
            userObj.matchScore = calculateMatchScore(userObj, currentUser);
            
            return maskUserForPrivacy(userObj, req.user.id, false, connection);
        });

        console.log(`[ARCHIVE DISCOVERY] Successfully curated ${matches.length} alliances for discovery.`);
        res.json({ success: true, data: matches });
    } catch (error) { 
        console.error('[ARCHIVE ERROR] Discovery Engine Breakdown:', error);
        res.status(500).json({ success: false, message: error.message }); 
    }
};

exports.getReceivedInterests = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const interests = await Interest.find({ receiver: req.user.id }).populate('sender').sort({ createdAt: -1 });
        const filteredInterests = interests.map(i => {
            const interest = i.toObject();
            const canSeePhotos = interest.isAdminApproved && interest.status === 'accepted';
            if (interest.sender && !canSeePhotos) {
                interest.sender.profilePhotos = [];
                interest.sender.profileImage = '';
                interest.sender.personalDetails = {};
            }
            return interest;
        });
        res.json({ success: true, data: filteredInterests });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getSentInterests = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const interests = await Interest.find({ sender: req.user.id }).populate('receiver').sort({ createdAt: -1 });
        const filteredInterests = interests.map(i => {
            const interest = i.toObject();
            const canSeePhotos = interest.isAdminApproved && interest.status === 'accepted';
            if (interest.receiver && !canSeePhotos) {
                interest.receiver.profilePhotos = [];
                interest.receiver.profileImage = '';
                interest.receiver.personalDetails = {};
            }
            return interest;
        });
        res.json({ success: true, data: filteredInterests });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.sendInterest = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user.status.isPremium) {
            return res.status(403).json({ 
                success: false, 
                message: 'Only Premium Heritage members can initiate interest. Please ascend to a premium tier.' 
            });
        }
        // 1. Check if I already sent an interest (Avoid duplicates)
        const existingInterest = await Interest.findOne({
            sender: req.user.id,
            receiver: req.body.receiverId
        });

        if (existingInterest) {
            return res.status(400).json({ 
                success: false, 
                message: 'A proposal for this alliance is already active in the registry.' 
            });
        }

        // 2. Check if they already sent me an interest (Reciprocal Achievement)
        const reciprocalInterest = await Interest.findOne({
            sender: req.body.receiverId,
            receiver: req.user.id,
            status: 'pending'
        });

        if (reciprocalInterest) {
            reciprocalInterest.status = 'accepted';
            await reciprocalInterest.save();
            
            await Notification.create({
                receiver: req.body.receiverId,
                sender: req.user.id,
                type: 'accept'
            });
            
            return res.status(200).json({ 
                success: true, 
                message: 'Alliances have met. Mutual interest achieved.', 
                data: reciprocalInterest 
            });
        }

        // 3. Create fresh proposal
        const interest = await Interest.create({ 
            sender: req.user.id, 
            receiver: req.body.receiverId 
        });

        await Notification.create({
            receiver: req.body.receiverId,
            sender: req.user.id,
            type: 'interest'
        });
        const io = req.app.get('socketio');
        if (io) {
            io.to(req.body.receiverId).emit('notification', {
                message: `You received a new interest from ${req.user.name || 'a member'}`,
                type: 'interest',
                sender: req.user.id
            });
        }
        res.status(201).json({ success: true, data: interest });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.cancelInterest = async (req, res) => {
    try {
        await Interest.findOneAndDelete({ sender: req.user.id, receiver: req.body.receiverId });
        await Notification.findOneAndDelete({ sender: req.user.id, receiver: req.body.receiverId, type: 'interest' });
        res.json({ success: true, message: 'Interest cancelled' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.shortlistUser = async (req, res) => {
    try {
        const existing = await Shortlist.findOne({ sender: req.user.id, receiver: req.body.receiverId });
        if (existing) { await Shortlist.findByIdAndDelete(existing._id); return res.json({ success: true, action: 'removed' }); }
        await Shortlist.create({ sender: req.user.id, receiver: req.body.receiverId });
        res.json({ success: true, action: 'added' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.ignoreUser = async (req, res) => {
    try {
        await Ignore.create({ sender: req.user.id, receiver: req.body.receiverId });
        res.json({ success: true, message: 'User ignored' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getViewers = async (req, res) => {
    try {
        const views = await ProfileView.find({ profile: req.user.id }).populate('viewer').sort({ createdAt: -1 });
        const filteredViews = await Promise.all(views.map(async (v) => {
            if (!v.viewer) return null;
            const viewer = v.viewer.toObject();
            const connection = await Interest.findOne({
                $or: [
                    { sender: req.user.id, receiver: viewer._id, status: 'accepted' },
                    { sender: viewer._id, receiver: req.user.id, status: 'accepted' }
                ]
            });
            if (!connection || !connection.isAdminApproved) {
                viewer.profilePhotos = [];
                viewer.profileImage = '';
                viewer.personalDetails = {};
            }
            return viewer;
        }));
        res.json({ success: true, data: filteredViews.filter(u => u != null) });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getShortlistedBy = async (req, res) => {
    try {
        const sh = await Shortlist.find({ receiver: req.user.id }).populate('sender').sort({ createdAt: -1 });
        const filteredShortlists = await Promise.all(sh.map(async (s) => {
            if (!s.sender) return null;
            const sender = s.sender.toObject();
            const connection = await Interest.findOne({
                $or: [
                    { sender: req.user.id, receiver: sender._id, status: 'accepted' },
                    { sender: sender._id, receiver: req.user.id, status: 'accepted' }
                ]
            });
            if (!connection || !connection.isAdminApproved) {
                sender.profilePhotos = [];
                sender.profileImage = '';
                sender.personalDetails = {};
            }
            return sender;
        }));
        res.json({ success: true, data: filteredShortlists.filter(u => u != null) });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.updateProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        const { basicInfo, personalDetails, contactInfo, partnerPreferences } = req.body;
        if (basicInfo) {
            const { email, ...restBasic } = basicInfo;
            if (email) user.contactInfo.email = email;
            user.basicInfo = { ...user.basicInfo, ...restBasic };
        }
        if (personalDetails) user.personalDetails = { ...user.personalDetails, ...personalDetails };
        if (contactInfo && contactInfo.location) {
            user.contactInfo.location = { ...user.contactInfo.location, ...contactInfo.location };
        }
        if (partnerPreferences) {
            const { ageMin, ageMax, religion, caste, city, education, ...rest } = partnerPreferences;
            user.partnerPreferences = { 
                ...user.partnerPreferences?.toObject(), 
                ...rest,
                ageRange: {
                    min: ageMin !== undefined ? parseInt(ageMin) : user.partnerPreferences?.ageRange?.min,
                    max: ageMax !== undefined ? parseInt(ageMax) : user.partnerPreferences?.ageRange?.max
                },
                religion: religion ? [religion] : user.partnerPreferences?.religion,
                caste: caste ? [caste] : user.partnerPreferences?.caste,
                location: city ? [city] : user.partnerPreferences?.location,
                education: education ? [education] : user.partnerPreferences?.education
            };
        }
        await user.save();
        res.json({ success: true, data: user });
    } catch (error) { 
        res.status(500).json({ success: false, message: error.message }); 
    }
};

exports.upgradeUser = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        user.status.isPremium = true;
        await user.save();
        res.json({ success: true, data: user });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getUser = async (req, res) => {
    try {
        const currentUser = await User.findById(req.user.id);
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Profile not found' });
        
        const isOwner = req.user && req.user.id === req.params.id;
        const isAdmin = req.user && (req.user.role === 'Admin' || req.user.role === 'admin');
        
        const userData = user.toObject();
        let connection = null;
        if (!isOwner && !isAdmin && req.user) {
            connection = await Interest.findOne({
                $or: [
                    { sender: req.user.id, receiver: user._id, status: 'accepted' },
                    { sender: user._id, receiver: req.user.id, status: 'accepted' }
                ]
            });
        }
        
        const finalData = maskUserForPrivacy(userData, req.user.id, isAdmin, connection);
        res.json({ success: true, data: finalData });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getChatList = async (req, res) => {
    try {
        const messages = await Message.find({ $or: [{ sender: req.user.id }, { receiver: req.user.id }] }).sort({ createdAt: -1 });
        const peerIds = [...new Set(messages.map(m => m.sender.toString() === req.user.id.toString() ? m.receiver.toString() : m.sender.toString()))];
        const chatPeers = await User.find({ _id: { $in: peerIds } });
        const chatList = await Promise.all(chatPeers.map(async (peer) => {
            const lastMsg = await Message.findOne({ $or: [{ sender: req.user.id, receiver: peer._id }, { sender: peer._id, receiver: req.user.id }] }).sort({ createdAt: -1 });
            const connection = await Interest.findOne({ $or: [{ sender: req.user.id, receiver: peer._id, status: 'accepted' }, { sender: peer._id, receiver: req.user.id, status: 'accepted' }] });
            const isApproved = connection && connection.isAdminApproved;
            const peerObj = peer.toObject();
            if (!isApproved) { peerObj.profilePhotos = []; peerObj.profileImage = ''; peerObj.personalDetails = {}; }
            return { peer: peerObj, lastMsg };
        }));
        res.json({ success: true, data: chatList.sort((a,b) => {
            const dateA = a.lastMsg ? new Date(a.lastMsg.createdAt) : 0;
            const dateB = b.lastMsg ? new Date(b.lastMsg.createdAt) : 0;
            return dateB - dateA;
        })});
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getNotifications = async (req, res) => {
    try {
        const notifications = await Notification.find({ receiver: req.user.id }).populate('sender').sort({ createdAt: -1 }).limit(20);
        const filteredNotifications = await Promise.all(notifications.map(async (n) => {
            const notif = n.toObject();
            if (notif.sender) {
                const connection = await Interest.findOne({ $or: [{ sender: req.user.id, receiver: notif.sender._id, status: 'accepted' }, { sender: notif.sender._id, receiver: req.user.id, status: 'accepted' }] });
                if (!connection || !connection.isAdminApproved) { notif.sender.profilePhotos = []; notif.sender.profileImage = ''; notif.sender.personalDetails = {}; }
            }
            return notif;
        }));
        res.json({ success: true, data: filteredNotifications });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.markNotificationsRead = async (req, res) => {
    try { await Notification.updateMany({ receiver: req.user.id, isRead: false }, { $set: { isRead: true } }); res.json({ success: true }); } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.uploadProfilePhoto = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        const user = await User.findById(req.user.id);
        const photoUrl = req.file.path;
        if (!user.profilePhotos) user.profilePhotos = [];
        if (!user.profilePhotos.includes(photoUrl)) user.profilePhotos.push(photoUrl);
        if (!user.profileImage || user.profileImage === '') user.profileImage = photoUrl;
        await user.save();
        res.json({ success: true, data: user, url: photoUrl });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.deleteProfilePhoto = async (req, res) => {
    try {
        const { photoUrl } = req.body;
        const user = await User.findById(req.user.id);
        user.profilePhotos = user.profilePhotos.filter(p => p !== photoUrl);
        if (user.profileImage === photoUrl) user.profileImage = user.profilePhotos[0] || '';
        await user.save();
        res.json({ success: true, data: user });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

exports.getProfileMetrics = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const viewsCount = await ProfileView.countDocuments({ profile: req.user.id });
        const precisionRating = user.calculateCompleteness();
        const photoBonus = (user.profilePhotos?.length || 0) * 5;
        const matchScoreImpact = Math.min(100, Math.round(precisionRating * 0.8 + photoBonus));
        res.json({ success: true, stats: { totalViews: viewsCount || 0, matchScore: matchScoreImpact, auditPrecision: precisionRating } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
};

// @desc    Get active announcement for users
// @route   GET /api/users/announcement
exports.getAnnouncement = async (req, res) => {
    try {
        const announcement = await Announcement.findOne({ isActive: true }).sort({ createdAt: -1 });
        res.json({ success: true, data: announcement });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
