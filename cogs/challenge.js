import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { config } from '../utils/config.js';
import { requireSupporter } from '../utils/roleGuard.js';
import { ensureLinkedToken, PlayerLinks } from '../utils/playerLinks.js';
import { getPlayerProfileByUserId } from '../utils/deckUtils.js';
import { createChallengeSession, decideChallenge, expireChallenge } from '../logic/duelSessions.js';

export default async function registerChallenge(client){
  const data=new SlashCommandBuilder().setName('challenge').setDescription('Challenge another linked player to a duel.').addUserOption(o=>o.setName('opponent').setDescription('Player to challenge').setRequired(true)).setDMPermission(false);
  client.slashData.push(data.toJSON());client.commands.set('challenge',{data,async execute(i){
    if(!requireSupporter(i.member))return i.reply({content:'❌ Supporter or Elite Collector role required.',ephemeral:true});
    if(config.battlefield_channel_id&&String(i.channelId)!==String(config.battlefield_channel_id))return i.reply({content:`⚠️ Use this in <#${config.battlefield_channel_id}>.`,ephemeral:true});
    const opponent=i.options.getUser('opponent',true);if(opponent.bot||opponent.id===i.user.id)return i.reply({content:'❌ Choose another human player.',ephemeral:true});
    try{
      await i.deferReply({ephemeral:true});const challengerToken=await ensureLinkedToken(i.user.id,i.user.username);const opponentProfile=await getPlayerProfileByUserId(opponent.id);if(!opponentProfile?.token)return i.editReply('❌ That player is not linked.');
      const session=await createChallengeSession({challengerId:i.user.id,challengerToken,challengerName:i.user.username,opponentId:opponent.id,opponentToken:opponentProfile.token,opponentName:opponent.username});
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`challenge_accept_${session.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`challenge_deny_${session.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger));
      let dm;try{dm=await opponent.send({content:`⚔️ **${i.user.username}** challenged you to an SV13 TCG duel.`,components:[row]});}catch{await expireChallenge(session.id).catch(()=>{});return i.editReply('❌ I could not DM that player. They must allow server DMs to receive the challenge.');}
      await i.editReply(`⚔️ Challenge sent to **${opponent.username}**. Session: \`${session.id}\``);
      const choice=await dm.awaitMessageComponent({filter:x=>x.user.id===opponent.id,time:120000}).catch(()=>null);
      if(!choice){await expireChallenge(session.id).catch(()=>{});return dm.edit({content:'⏰ Challenge expired.',components:[]}).catch(()=>{});}
      const decision=choice.customId.startsWith('challenge_accept_')?'accept':'deny';await decideChallenge(session.id,opponentProfile.token,decision);
      if(decision==='deny')return choice.update({content:'❌ Challenge denied.',components:[]});
      await choice.update({content:`✅ Challenge accepted.\n**Your private duel link:** ${PlayerLinks.duel(session.id,opponentProfile.token)}`,components:[]});
      try{await i.user.send(`✅ **${opponent.username}** accepted your challenge.\n**Your private duel link:** ${PlayerLinks.duel(session.id,challengerToken)}\n**Spectator link:** ${PlayerLinks.spectator(session.id)}`);}catch{}
    }catch(e){const msg=`❌ ${e?.message||e}`;if(i.deferred||i.replied)return i.editReply(msg);return i.reply({content:msg,ephemeral:true});}
  }});
}
