import fs from 'fs';
import path from 'path';
import async from 'async';
import _ from 'underscore';
import glob from 'glob';

// @ts-ignore
import ffmpegPath from 'ffmpeg-static';

export type AudioFormat = 'aiff' | 'wav' | 'ac3' | 'mp3' | 'mp4' | 'm4a' | 'ogg' | 'opus' | 'webm';

export type AudioSpriteOptions = {
  output?: string,
  path?: string,
  export?: string | AudioFormat[],
  format?: string,
  autoplay?: boolean,
  loop?: string[],
  silence?: number,
  gap?: number,
  minlength?: number,
  bitrate?: 32 | 64 | 96 | 128 | 160 | 192 | 256 | 320,
  vbr?: number,
  'vbr:vorbis'?: number,
  samplerate?: number,
  channels?: number,
  rawparts?: string | string[],
  ignorerounding?: number,
  logger?: {
    debug: Function,
    info: Function,
    log: Function
  }
}

const defaults: AudioSpriteOptions = {
  output: 'output',
  path: '',
  export: 'ogg,m4a,mp3,ac3',
  format: undefined,
  autoplay: undefined,
  loop: [],
  silence: 0,
  gap: 1,
  minlength: 0,
  bitrate: 128,
  vbr: -1,
  'vbr:vorbis': -1,
  samplerate: 44100,
  channels: 1,
  rawparts: '',
  ignorerounding: 0,
  logger: {
    debug: function(){},
    info: function(){},
    log: function(){}
  }
}

export default function (files: string[], options?: AudioSpriteOptions): Promise<any> {
  return new Promise((resolve, reject) => {

    if (!files || !files.length) {
      return reject(new Error('No files provided'));

    } else {
      files = _.flatten(files.map(file => glob.sync(file)));
    }

    options = _.extend({}, defaults, options)

    // make sure output directory exists
    const outputDir = path.dirname(options.output)
    if (!fs.existsSync(outputDir)) {
      require('mkdirp').sync(outputDir)
    }

    let offsetCursor = 0
    const wavArgs = ['-ar', options.samplerate.toString(), '-ac', options.channels.toString(), '-f', 's16le']
    const tempFile = mktemp('audiosprite')

    options.logger.debug('Created temporary file', { file: tempFile })

    const json: any = {
      resources: [],
      spritemap: {}
    }

    spawn(ffmpegPath, ['-version']).on('exit', code => {
      if (code) {
        return reject(new Error('ffmpeg was not found on your path'));
      }

      if (options.silence) {
        json.spritemap.silence = {
          start: 0,
          end: options.silence,
          loop: true
        }

        if (!options.autoplay) {
          json.autoplay = 'silence'
        }

        appendSilence(options.silence + options.gap, tempFile, processFiles)
      } else {
        processFiles()
      }
    })

    function mktemp(prefix) {
      var tmpdir = require('os').tmpdir() || '.';
      return path.join(tmpdir, prefix + '.' + Math.random().toString().substr(2));
    }

    function spawn(name, opt) {
      options.logger.debug('Spawn', { cmd: [name].concat(opt).join(' ') });
      return require('child_process').spawn(name, opt);
    }

    function pad(num, size) {
      var str = num.toString();

      while (str.length < size) {
        str = '0' + str;
      }

      return str;
    }

    function makeRawAudioFile(src, cb) {
      var dest = mktemp('audiosprite')

      options.logger.debug('Start processing', { file: src })

      fs.exists(src, function(exists) {
        if (exists) {
          let code = -1
          let signal = undefined;

          const ffmpeg = spawn(ffmpegPath, ['-i', path.resolve(src)].concat(wavArgs).concat('pipe:'))
          const streamFinished = _.after(2, function () {
            if (code) {
              return cb({
                msg: 'File could not be added',
                file: src,
                retcode: code,
                signal: signal
              })
            }
            cb(null, dest)
          });

          const writeStream = fs.createWriteStream(dest, {flags: 'w'});
          ffmpeg.stdout.pipe(writeStream);
          writeStream.on('close', () => streamFinished());

          ffmpeg.on('close', function(_code, _signal) {
            code = _code
            signal = _signal
            streamFinished()
          });
        }
        else {
          cb({ msg: 'File does not exist', file: src })
        }
      })
    }

    function appendFile(name, src, dest, cb) {
      var size = 0
      var reader = fs.createReadStream(src)
      var writer = fs.createWriteStream(dest, {
        flags: 'a'
      })
      reader.on('data', function(data) {
        size += data.length
      })
      reader.on('close', function() {
        var originalDuration = size / options.samplerate / options.channels / 2
        options.logger.info('File added OK', { file: src, duration: originalDuration })
        var extraDuration = Math.max(0, options.minlength - originalDuration)
        var duration = originalDuration + extraDuration
        json.spritemap[name] = {
          start: offsetCursor
          , end: offsetCursor + duration
          , loop: name === options.autoplay || options.loop.indexOf(name) !== -1
        }
        offsetCursor += originalDuration

        var delta = Math.ceil(duration) - duration;

        if (options.ignorerounding)
        {
          options.logger.info('Ignoring nearest second silence gap rounding');
          extraDuration = 0;
          delta = 0;
        }

        appendSilence(extraDuration + delta + options.gap, dest, cb)
      })
      reader.pipe(writer)
    }

    function appendSilence(duration, dest, cb) {
      var buffer = Buffer.alloc(Math.round(options.samplerate * 2 * options.channels * duration), 0);
      var writeStream = fs.createWriteStream(dest, { flags: 'a' })
      writeStream.end(buffer)
      writeStream.on('close', function() {
        options.logger.info('Silence gap added', { duration: duration })
        offsetCursor += duration
        cb()
      })
    }

    function exportFile(src, dest, ext, opt, store, cb) {
      var outfile = dest + '.' + ext;

      spawn(ffmpegPath, ['-y', '-ar', options.samplerate, '-ac', options.channels, '-f', 's16le', '-i', src]
        .concat(opt).concat(outfile))
        .on('exit', function(code, signal) {
          if (code) {
            return cb({
              msg: 'Error exporting file',
              format: ext,
              retcode: code,
              signal: signal
            })
          }
          if (ext === 'aiff') {
            exportFileCaf(outfile, dest + '.caf', function(err) {
              if (!err && store) {
                json.resources.push(dest + '.caf')
              }
              fs.unlinkSync(outfile)
              cb()
            })
          } else {
            options.logger.info('Exported ' + ext + ' OK', { file: outfile })
            if (store) {
              json.resources.push(outfile)
            }
            cb()
          }
        })
    }

    function exportFileCaf(src, dest, cb) {
      if (process.platform !== 'darwin') {
        return cb(true)
      }

      spawn('afconvert', ['-f', 'caff', '-d', 'ima4', src, dest])
        .on('exit', function(code, signal) {
          if (code) {
            return cb({
              msg: 'Error exporting file',
              format: 'caf',
              retcode: code,
              signal: signal
            })
          }
          options.logger.info('Exported caf OK', { file: dest })
          return cb()
        })
    }

    function processFiles() {
      let formats: { [format in AudioFormat]: string[] } = {
        aiff: [],
        wav: [],
        ac3: ['-acodec', 'ac3', '-ab', options.bitrate + 'k'],
        mp3: ['-ar', `${options.samplerate}`, '-f', 'mp3'],
        mp4: ['-ab', options.bitrate + 'k'],
        m4a: ['-ab', options.bitrate + 'k', '-strict', '-2'],
        ogg: ['-acodec', 'libvorbis', '-f', 'ogg', '-ab', options.bitrate + 'k'],
        opus: ['-acodec', 'libopus', '-ab', options.bitrate + 'k'],
        webm: ['-acodec', 'libvorbis', '-f', 'webm', '-dash', '1'],
      };

      if (options.vbr >= 0 && options.vbr <= 9) {
        formats.mp3 = formats.mp3.concat(['-aq', `${options.vbr}`])
      }
      else {
        formats.mp3 = formats.mp3.concat(['-ab', options.bitrate + 'k'])
      }

      // change quality of webm output - https://trac.ffmpeg.org/wiki/TheoraVorbisEncodingGuide
      if (options['vbr:vorbis'] >= 0 && options['vbr:vorbis'] <= 10) {
        formats.webm = formats.webm.concat(['-qscale:a', String(options['vbr:vorbis'])])
      }
      else {
        formats.webm = formats.webm.concat(['-ab', options.bitrate + 'k'])
      }

      if (typeof (options.export) === "string") {
        formats = (options.export.split(',') as AudioFormat[]).reduce(function(memo, val) {
          if (formats[val]) {
            memo[val] = formats[val];
          }
          return memo;
        }, {} as any);
      }

      var rawparts = typeof (options.rawparts) === "string" ? options.rawparts.split(',') : null
      var i = 0
      options.logger.info(files);
      async.forEachSeries(files, function(file, cb) {
        i++

        makeRawAudioFile(file, function(err, tmp) {
          if (err) {
            options.logger.debug(err);
            return cb(err)
          }

          function tempProcessed() {
            fs.unlinkSync(tmp)
            cb()
          }

          var name = path.basename(file).replace(/\.[a-zA-Z0-9]+$/, '')
          appendFile(name, tmp, tempFile, function(err) {
            if (rawparts != null ? rawparts.length : void 0) {
              async.forEachSeries(rawparts, function(ext, cb) {
                options.logger.debug('Start export slice', { name: name, format: ext, i: i })
                exportFile(tmp, options.output + '_' + pad(i, 3), ext, formats[ext]
                , false, cb)
              }, tempProcessed)
            } else {
              tempProcessed()
            }
          })
        })
      }, function(err) {
        if (err) {
          return reject(new Error(`Error adding file ${err.message}`));
        }

        async.forEachSeries(Object.keys(formats), function(ext, cb) {
          options.logger.debug('Start export', { format: ext })
          exportFile(tempFile, options.output, ext, formats[ext], true, cb)
        }, function(err) {
          if (err) {
            return reject(new Error('Error exporting file'));
          }
          if (options.autoplay) {
            json.autoplay = options.autoplay
          }

          json.resources = json.resources.map(function(e) {
            return options.path ? path.join(options.path, path.basename(e)) : e
          })

          var finalJson: any = {}
          switch (options.format) {

            case 'howler':
            case 'howler2':
              finalJson[options.format === 'howler' ? 'urls' : 'src'] = [].concat(json.resources)
              finalJson.sprite = {}
              for (var sn in json.spritemap) {
                var spriteInfo = json.spritemap[sn]
                finalJson.sprite[sn] = [spriteInfo.start * 1000, (spriteInfo.end - spriteInfo.start) * 1000]
                if (spriteInfo.loop) {
                  finalJson.sprite[sn].push(true)
                }
              }
              break;

            case 'createjs':
              finalJson.src = json.resources[0]
              finalJson.data = {audioSprite: []}
              for (var sn in json.spritemap) {
                var spriteInfo = json.spritemap[sn]
                finalJson.data.audioSprite.push({
                  id: sn,
                  startTime: spriteInfo.start * 1000,
                  duration: (spriteInfo.end - spriteInfo.start) * 1000
                })
              }
              break

            case 'default':
            default:
              finalJson = json
              break
          }

          fs.unlinkSync(tempFile)

          return resolve(finalJson);
        })
      });
    }

  });
}
