module.exports = {
    processRequest, connect, getInfo, useCard, getCardEffect
}

var mongodb, ucollection, ccollection;
const fs = require('fs');
const _ = require("lodash");
const crafted = require('../crafted/cards.json');
const logger = require('./log.js');
const utils = require('./localutils.js');
const heroes = require('./heroes.js');
const quest = require('./quest.js');
const dbManager = require("./dbmanager.js");
const inv = require("./inventory.js");
const cryst = require("./crystal.js");

var collections = [];
fs.readdir('./cards', (err, items) => {
    if(err) console.log(err);
    for (var i = 0; i < items.length; i++) {
        if(items[i][0] != '=' && items[i] != "special")
            collections.push(items[i]);
    }
});

function connect(db) {
    mongodb = db;
    ucollection = db.collection('users');
    ccollection = db.collection('cards');
    cryst.connect(db);
}

function processRequest(userID, args, callback) {
    ucollection.findOne({ discord_id: userID }).then((dbUser) => {
        if(!dbUser) return;

        var req = args.shift();
        switch(req) {
            case "info":
                if(args.length > 0)
                    getInfo(dbUser, args.join('_'), callback);
                break;
            default:
                args.unshift(req)
                craftCard(dbUser, args, callback);
                break;
        }
    }).catch(e => logger.error(e));
}

function getCardByName(name) {
    return crafted.filter(c => c.name.includes(name) || c.cards.filter(cc => cc.includes(name)) != 0)[0];
}

function getInfo(user, name, callback, image = false) {
    var card = getCardByName(name);
    if(card) {
        let cardName = utils.toTitleCase(card.name.replace(/_/g, " "));
        let res = "Info about **" + cardName + "** effect card:";
        res += "\nForge cost: **" +  getCardEffect(user, 'forge', card.cost) + "**🍅";
        res += "\nRequired hero level: **" + card.level + "**";
        res += "\nRequired cards: ";
        for(i in card.cards) {
            res += "**" + utils.toTitleCase(card.cards[i].replace(/_/g, " ")) + "**";
            res += ((i == card.cards.length - 1)? " " : ", ");
        }
        res += "\nEffect: **" + card.effect + "**";
        if(card.cooldown) res += "\nCooldown: **" + card.cooldown + "**";
        if(card.usage) res += "\nUsage: " + card.usage;
        if(!image) res += "\nUse `->forge [card1], [card2], ...`";
        callback(res, image? 
            "./crafted/" + card.name + (card.animated? '.gif' : '.png') : undefined);
    } else callback("**" + user.username + 
        "**, effect card with name **" + name.replace(/_/g, " ") + 
        "** was not found");
}

function craftCard(user, args, callback) {
    var cards = args.join('_').split(',');
    if(!cards || cards.length < 2) {
        callback("Minimum **2** cards or items required for forge\nDon't forget to put `,` between names"
            + "\nInclude only card/item **name**\nFor crystals always put `*` before name");
        return;
    }

    let cardNames = [];
    let cardObjects = [];
    var mode = "";
    for(i in cards) {
        let name = cards[i];
        if(name.includes("*")){ 
            if(mode == "card")
                return callback("**" + user.username 
                    + "**, you can't combine cards and items in forge request");
            mode = "cryst";
        } else {
            if(mode == "cryst")
                return callback("**" + user.username 
                    + "**, you can't combine cards and items in forge request");
            mode = "card";

            if(cards[i][0] == "_") 
                name = cards[i].substr(1); 

            let card = dbManager.getBestCardSorted(user.cards, name)[0];
            if(!card) {
                callback("**" + user.username 
                    + "**, card with name **" + name.replace(/_/g, " ")
                    + "** was not found, or you don't have it");
                return;
            }
            cardNames.push(card.name.toLowerCase());
            cardObjects.push(card);
        }
    }

    if(mode == "cryst")
        return cryst.forgeCrystals(user, cards, callback)

    let isCraft = cardObjects[0].craft;
    if(!isCraft) isCraft = false;
    for(i in cardObjects) {
        var cr = cardObjects[i].craft == undefined? false : cardObjects[i].craft;
        if(cr != isCraft) {
            callback("**Error** \nAll cards have to be the same type "
                + "(you can't mix **craft** and **ordinary** cards)");
            return;
        }
    }

    if(!isCraft) {
        craftOrdinary(user, cardObjects, callback);
        return;
    }

    for(i in crafted) {
        let count = 0;
        let dif = crafted[i].cards.filter(c => !cardNames.includes(c));

        if(dif.length == 0) {
            let err = "";
            let curName = utils.toTitleCase(crafted[i].name.replace(/_/g, " "));
            //let cost = heroes.getHeroEffect(user, 'forge', crafted[i].cost);
            let cost =  getCardEffect(user, 'forge', crafted[i].cost);
            if(user.exp < cost) {
                err += "**" + user.username + "**, you don't have enough 🍅 Tomatoes "
                + "to craft this card. You need at least **" + cost + "**🍅\n";
            }

            if(!user.hero || parseFloat(heroes.getHeroLevel(user.hero.exp)) < crafted[i].level) {
                err += "**" + user.username + "**, your **hero level** is lower, than "
                + "required level **" + crafted[i].level + "**\n";
            }

            if(err != "") {
                callback(err + "To see all requirements, use `->forge info " + curName + "`");
                return;
            }

            for(j in cardNames) {
                let match = user.cards.filter(c => c.name.toLowerCase() == cardNames[j])[0];
                if(match) {
                    user.cards = dbManager.removeCardFromUser(user.cards, match);
                } else {
                    callback("**" + user.username + "**, can't find needed card among yours");
                    return;
                }
            }

            heroes.addXP(user, 20);
            ucollection.update( 
                { discord_id: user.discord_id},
                { 
                    $push: {inventory: {
                        name: crafted[i].name, 
                        cooldown: crafted[i].cooldown,
                        type: 'craft'}},
                    $inc: {exp: -cost},
                    $set: {cards: user.cards }
                }
            ).then(u => {
                callback("**" + user.username 
                + "**, you crafted **" 
                + curName + "**\n"
                + "Card was added to your inventory. Card effect:\n**"
                + crafted[i].effect + "**\n"
                + "Use `->inv` to check your inventory", 
                "./crafted/" + crafted[i].name + (crafted[i].animated? '.gif' : '.png'));
            }).catch(e => logger.error(e));
            return;
        }
    }

    callback("**" + user.username 
        + "**, you can't forge an **effect card** using those source cards. Please check the requirements by running `->forge info [craft card name]`");
}

function craftOrdinary(user, cards, callback) {
    let level = cards[0].level;
    let crCost =  getCardEffect(user, 'forge', heroes.getHeroEffect(user, 'forge', level * 120));
    if(user.exp < crCost) {
        callback("**" + user.username + "**, you don't have enough 🍅 Tomatoes to perform forge. "
            + "You need at least **" + crCost + "** but you have **" + Math.floor(user.exp) + "**");
        return;
    }

    let collection = cards[0].collection;

    if(collection === "christmas")
        return cryst.getCrystals(user, cards, callback);

    let passed = [];
    for(i in cards) {
        if(cards[i].level != level) {
            callback("**" + user.username + "**, please, specify cards of the same level");
            return;
        }

        if(passed.includes(cards[i].name)) {
            callback("**" + user.username + "**, you can't use cards with same name!");
            return;
        }

        if(cards[i].collection != collection) collection = null;
        passed.push(cards[i].name);
    }

    if((level == 1 && cards.length > 4) 
        || (level == 1 && cards.level == 3)
        || (level == 2 && cards.length > 2)) {
        callback("**" + user.username + "**, card amount mismatch.\n"
            + "You need **two or four 1-star cards** or **two 2-star cards**");
        return;
    }

    if(level == 1 && cards.length >= 4) level = 3;
    else if(level != 3) level += 1;

    for(j in cards) {
        let match = utils.containsCard(user.cards, cards[j]);
        if(match) user.cards = dbManager.removeCardFromUser(user.cards, match);
    }

    let req = {level: level};
    if(collection) req.collection = collection;
    heroes.addXP(user, .2);
    requestCard(user, req, (m, o, c) => {
        quest.checkForge(user, level, callback);
        user.cards = dbManager.addCardToUser(user.cards, c);
        ucollection.update( 
            { discord_id: user.discord_id},
            { 
                $set: {cards: user.cards },
                $inc: {exp: -crCost}
            }
        ).then(u => { 
            //if(bonus[0] > 0) m += "\nAdded " + bonus[0] + "🍅 Tomatoes from card effect";
            callback(m, o);
        }).catch(e => {logger.error(e)});
    });
}

// For cards with passive effects
function getCardEffect(user, action, ...params) {
    switch(action) {
        case 'claim':
            if(inv.has(user, 'gift_from_tohru') 
                && (!user.dailystats || user.dailystats.claim == 0)) {
                params[0] = true;
            }
            break;
        case 'heroup':
            if(inv.has(user, 'onward_to_victory')) params[0] += params[0] * .5;
            break;
        case 'sell':
            if(inv.has(user, 'sushi_squad')) params[0] += params[0] * .2;
            break;
        case 'daily':
            if(inv.has(user, 'blue_free_eyes')) params[0] += 200;
            if(inv.has(user, 'the_ruler_jeanne')) params[1] = 15;
            break;
        case 'forge':
            if(inv.has(user, 'cherry_blossoms')) params *= .5;
            break;
        case 'send':
            if(params[0].inventory && inv.has(params[0], 'skies_of_friendship')) {
                ucollection.update( 
                    { discord_id: user.discord_id},
                    { $inc: {exp: 100} }
                ).then(u => {
                    params[1]("**" + user.username + "**, you got **100 Tomatoes** for sending card to this user");
                });
            }
            break;
    }
    return params;
}

// For cards that are used
function useCard(user, name, args, callback) {
    let fullName = utils.toTitleCase(name.replace(/_/g, " "));
    let isComplete = false;

    switch(name) {
        case 'delightful_sunset':
            isComplete = reduceClaims(user, fullName, callback);
            break;
        case 'long-awaited_date':
            isComplete = completeQuest(user, fullName, callback);
            break;
        case 'the_space_unity':
            isComplete = getClaimedCard(user, fullName, args, callback);
            break;
        case 'the_judgment_day':
            isComplete = useAny(user, fullName, args, callback);
            break;
    }

    return isComplete;
}

function useAny(user, fullName, args, callback) {
    if(args) {
        let newArgs = args.split(',');
        let tgName = newArgs[0].substring(1);
        let card = crafted.filter(c => c.name.includes(tgName))[0];

        if(card && card.name === 'the_judgment_day') return false;
        if(card && useCard(user, card.name, newArgs[1], callback)) return true;

        let resp = "**" + user.username + "**, failed to use **" 
            + (card? utils.toTitleCase(card.name.replace(/_/g, " ")) : tgName) + "**\n";
        resp +=  "You can use cards: 'Delightful Sunset', 'The Space Unity', 'Long-awaited Date'";
        callback(resp);
        return false;
    }

    let resp = "**" + user.username + "**, this card requires card name to be passed.\n" 
    resp += "Use `->inv use " + fullName.toLowerCase() + ", other usable craft`\n";
    resp +=  "You can use cards: 'Delightful Sunset', 'The Space Unity', 'Long-awaited Date'";
    callback(resp);
    return false;
}

function reduceClaims(user, fullName, callback) {
    if(user.dailystats && user.dailystats.claim > 4) {
        let claims = user.dailystats.claim - 4;
        ucollection.update( 
            { discord_id: user.discord_id},
            { $inc: {'dailystats.claim': -4} }
        ).then(u => {
            let claimPrice = 50 * (claims + 1);
            claimPrice = heroes.getHeroEffect(user, "claim_akari", claimPrice);
            callback("**" + user.username + "**, you used **" + fullName + "** "
                + "that reduced your claim cost to **" + claimPrice + "**");
        }).catch(e => logger.error(e));
        return true;
    }

    callback("Unable to use **" + fullName 
        + "** right now. You need to have your claim cost **250** Tomatoes or more");
    return false;
}

function completeQuest(user, fullName, callback) {
    if(user.quests && user.quests.length > 0) {
        quest.completeNext(user, callback);
        return true;
    }

    callback("**" + user.username + "**, can't use **" 
        + fullName + "**. There are no quests to complete");
    return false;
}

function getClaimedCard(user, fullName, args, callback) {
    if(args) {
        var foundarg =  args.substr(args.indexOf('-') + 1);
        var col = collections.filter(c => c.includes(foundarg))[0];
        if(col) {
            ccollection.find({ collection: col }).toArray((err, i) => {
                if(err){ logger.error(err); return; }

                let res = _.sample(i);
                if(!res) return;

                user.cards = dbManager.addCardToUser(user.cards, res);
                let name = utils.toTitleCase(res.name.replace(/_/g, " "));
                ucollection.update(
                    { discord_id: user.discord_id },
                    { $set: {cards: user.cards } }
                ).then(u => {
                    callback("**" + user.username + "**, you got **" + name + "**!",
                        dbManager.getCardFile(res));
                }).catch(e => logger.error(e));
            });
            return true;
        } else {
            callback("**" + user.username + "**, the collection **" 
                + foundarg + "** was not found");
        }
        return false;
    }

    let resp = "**" + user.username + "**, this card requires collection name to be passed.\n" 
    resp += "Use `->inv use " + fullName.toLowerCase() + ", -collection`\n";
    resp +=  "You can use collections: ";
    for(i in collections) resp += collections[i] + ', ';
    callback(resp);
    return false;
}

function requestCard(user, findObj, callback) {
    if(!findObj) findObj = {};
    ccollection.find(findObj).toArray((err, i) => {
        if(err){ return logger.error(err) }

        let res = _.sample(i);
        if(!res) return;
        
        let name = utils.toTitleCase(res.name.replace(/_/g, " "));
        callback("**" + user.username + "**, you got **" + name + "**!", dbManager.getCardFile(res), res);   
    });
}
