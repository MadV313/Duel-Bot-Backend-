import { SlashCommandBuilder } from 'discord.js';
import { PATHS, updateJSONAtomic } from '../utils/storageClient.js';
import { mintToken, PlayerLinks, validToken } from '../utils/playerLinks.js';
import { config } from '../utils/config.js';
import { normalizeDeck } from '../utils/deckUtils.js';

export default async function registerLinkDeck(client){
  const data=new SlashCommandBuilder().setName('linkdeck').setDescription('Link your Discord to create/update your SV13 TCG profile.').setDMPermission(false);
  client.slashData.push(data.toJSON()); client.commands.set('linkdeck',{data,async execute(interaction){
    if(config.manage_cards_channel_id && String(interaction.channelId)!==String(config.manage_cards_channel_id))return interaction.reply({content:`⚠️ Use this command in <#${config.manage_cards_channel_id}>.`,ephemeral:true});
    const uid=interaction.user.id,name=interaction.user.username;let token,already=false;
    try{
      await updateJSONAtomic(PATHS.linkedDecks,linked=>{let p=linked[uid];already=!!p;if(!p)p={discordId:uid,discordName:name,deck:{name:'My Deck',cards:[]},collection:{},createdAt:new Date().toISOString()};p.discordName=name;if(!p.collection||Array.isArray(p.collection))p.collection={};p.deck=normalizeDeck(p.deck||{name:'My Deck',cards:[]});if(!validToken(p.token))p.token=mintToken();p.lastLinkedAt=new Date().toISOString();token=p.token;linked[uid]=p;return linked;},{defaultValue:{}});
      await updateJSONAtomic(PATHS.wallet,bank=>{if(!Number.isFinite(Number(bank[uid])))bank[uid]=0;return bank;},{defaultValue:{}});
      await updateJSONAtomic(PATHS.playerData,stats=>{if(!stats[uid])stats[uid]={wins:0,losses:0};return stats;},{defaultValue:{}});
      return interaction.reply({content:[already?'ℹ️ Your profile was already linked; I refreshed it.':'✅ Your SV13 TCG profile is linked.','',`**Collection:** ${PlayerLinks.collection(token)}`,`**Deck Builder:** ${PlayerLinks.deck(token)}`,`**Player Stats:** ${PlayerLinks.stats(token)}`,'','Keep these player links private.'].join('\n'),ephemeral:true});
    }catch(e){return interaction.reply({content:`❌ Could not link your profile: ${e?.message||e}`,ephemeral:true});}
  }});
}
