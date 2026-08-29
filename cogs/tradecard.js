import { SlashCommandBuilder } from 'discord.js';
import { config } from '../utils/config.js';
import { requireSupporter } from '../utils/roleGuard.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';

function internalBase(){return String(process.env.INTERNAL_BACKEND_URL||`http://127.0.0.1:${process.env.PORT||3000}`).replace(/\/+$/,'');}
export default async function registerTradeCard(client){
  const data=new SlashCommandBuilder().setName('tradecard').setDescription(`Start a card trade with another linked player (${config.trade.daily_initiation_limit} trades/day).`).addUserOption(o=>o.setName('partner').setDescription('Player to trade with').setRequired(true)).setDMPermission(false);
  client.slashData.push(data.toJSON());client.commands.set('tradecard',{data,async execute(i){
    if(!requireSupporter(i.member))return i.reply({content:'❌ Supporter or Elite Collector role required.',ephemeral:true});if(config.manage_cards_channel_id&&String(i.channelId)!==String(config.manage_cards_channel_id))return i.reply({content:`⚠️ Use this in <#${config.manage_cards_channel_id}>.`,ephemeral:true});
    const partner=i.options.getUser('partner',true);if(partner.bot||partner.id===i.user.id)return i.reply({content:'❌ Choose another human player.',ephemeral:true});
    try{await i.deferReply({ephemeral:true});const token=await ensureLinkedToken(i.user.id,i.user.username);const key=String(process.env.BOT_API_KEY||process.env.BOT_KEY||'');if(!key)throw new Error('BOT_API_KEY is not configured');const r=await fetch(`${internalBase()}/trade/start`,{method:'POST',headers:{'Content-Type':'application/json','X-Bot-Key':key},body:JSON.stringify({initiatorToken:token,partnerId:partner.id})});const body=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(body.error||`Trade start failed (${r.status})`),{status:r.status});return i.editReply(`🤝 Trade started with **${partner.username}**.\n${body.urlInitiator}\n\nFinish your selections there; the bot will DM **${partner.username}** when their decision is needed.`);}catch(e){const msg=e?.status===429?`⛔ ${e.message}`:`❌ ${e?.message||e}`;if(i.deferred||i.replied)return i.editReply(msg);return i.reply({content:msg,ephemeral:true});}
  }});
}
