import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as os from 'os'
import * as path from 'path'
import { wait, waitFor } from './wait'

enum INPUT_OPTIONS {
  FLAVOR = 'flavor',
  CORES = 'cores',
  MEMORY = 'mememory',
  DISK = 'disk'
}

const DEFAULT_FLAVOR = '24.04'
const DEFAULT_NUM_CORES = '6'
const DEFAULT_SIZE_MEM = '32GiB'
const DEFAULT_SIZE_DISK = '50GB'
const OPENSTACK_VM_NAME = 'openstack'

// const UBUNTU_UID = '1000'
const UBUNTU_USER = 'ubuntu'
// const SNAP_DAEMON_GID = '584788'
// Use sudo -i -u 1000 due to: https://bugs.launchpad.net/snapd/+bug/2075560, otherwise
// "/system.slice/lxd-agent.service is not a snap cgroup" error will occur.
const EXEC_COMMAND_UBUNTU_USER = `lxc exec ${OPENSTACK_VM_NAME} -- sudo -i -u ${UBUNTU_USER}`
const SUNBEAM_ADMIN_CLOUD_NAME = 'sunbeam-admin'
const OPENSTACK_CLOUDS_YAML_PATH = path.parse(
  '/home/ubuntu/.config/openstack/clouds.yaml'
)
const NOBLE_CLOUD_IMAGE =
  'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const flavor: string = core.getInput(INPUT_OPTIONS.FLAVOR) || DEFAULT_FLAVOR
    const cores: string =
      core.getInput(INPUT_OPTIONS.CORES) || DEFAULT_NUM_CORES
    const mem: string = core.getInput(INPUT_OPTIONS.MEMORY) || DEFAULT_SIZE_MEM
    const disk: string = core.getInput(INPUT_OPTIONS.DISK) || DEFAULT_SIZE_DISK

    // Setup OpenStack VM
    core.startGroup('Initialize LXD')
    const user = os.userInfo().username
    await exec.exec('sudo lxd waitready')
    await exec.exec('sudo lxd init --auto')
    await exec.exec('sudo chmod a+wr /var/snap/lxd/common/lxd/unix.socket')
    await exec.exec('lxc network set lxdbr0 ipv6.address none')
    await exec.exec(`sudo usermod -a -G lxd ${user}`)
    core.endGroup()
    await exec.exec(
      `lxc launch ubuntu:${flavor} ${OPENSTACK_VM_NAME} --vm -d root,size=${disk} -c limits.cpu=${cores} -c limits.memory=${mem} --debug`,
      [],
      // hours wasted: 8
      {
        input: Buffer.from('')
      }
    )

    // wait for LXD agent to be running
    await waitFor(
      async () => {
        const lxcInfo = await exec.getExecOutput(
          `lxc info ${OPENSTACK_VM_NAME}`
        )
        const lxcStatus = yaml.load(lxcInfo.stdout) as any
        const processes = lxcStatus['Resources']['Processes']
        return processes !== -1
      },
      1000 * 60 * 5,
      1000 * 10
    )
    // wait for Ubuntu user to be setup
    await waitFor(
      async () => {
        const idCommandRetCode = await exec.exec('id ubuntu')
        const getEntRetCode = await exec.exec('getent passwd ubuntu')
        return idCommandRetCode === 0 && getEntRetCode === 0
      },
      1000 * 60 * 5,
      1000 * 10
    )
    // wait for 5 seconds for Ubuntu user to be properly propagated
    // otherwise the error "sudo: unknown user 1000" occurs
    await wait(1000 * 5)
    // wait for snapd service to come online and be seeded, otherwise
    // "dial unix /run/snapd.socket: connect: no such file or directory" error occurs.
    await waitFor(
      async () => {
        // lxc exec u1 -- sudo -i -u ubuntu sudo systemctl status snapd.seeded.service
        const snapSeededReturn = await exec.getExecOutput(
          'sudo systemctl status snapd.seeded.service',
          [],
          {
            ignoreReturnCode: true
          }
        )
        return snapSeededReturn.stdout.includes('active (exited)')
      },
      1000 * 60 * 5,
      1000 * 10
    )

    core.info('Installing OpenStack (Sunbeam) on VM')
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sudo snap install openstack --channel 2024.1/beta`
    )
    core.info('Preparing VM (Sunbeam)')
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} bash -c "sunbeam prepare-node-script | bash -x"`
    )
    core.info('Bootstrapping cluster (Sunbeam)')
    // lxc exec openstack -- sudo -i -u ubuntu sunbeam cluster bootstrap --accept-defaults
    await exec.exec(
      `${EXEC_COMMAND_UBUNTU_USER} sunbeam cluster bootstrap --accept-defaults`
    )
    core.info('Fetching admin credentials (Sunbeam)')
    const adminCloudConfigOutput = await exec.getExecOutput(
      `${EXEC_COMMAND_UBUNTU_USER} sunbeam cloud-config -a`
    )
    if (adminCloudConfigOutput.exitCode !== 0) {
      core.error(
        `sunbeam cloud config admin credentials failed with return code: ${adminCloudConfigOutput.exitCode}`
      )
      core.setFailed(adminCloudConfigOutput.stderr)
      return
    }
    fs.mkdirSync(OPENSTACK_CLOUDS_YAML_PATH.dir, { recursive: true })
    const cloudsYaml = adminCloudConfigOutput.stdout
    fs.writeFileSync(path.format(OPENSTACK_CLOUDS_YAML_PATH), cloudsYaml, {
      encoding: 'utf-8'
    })
    fs.writeFileSync('clouds.yaml', cloudsYaml, {
      encoding: 'utf-8'
    })

    // Set up host to route requests to OpenStack
    // example output:
    // "10.248.96.56 (enp5s0)
    // 10.20.20.1 (br-ex)
    // 10.1.0.114 (cilium_host)"
    core.info('Setting up host IP routing')
    const lxcListOutput = await exec.getExecOutput('lxc list --format=yaml')
    if (lxcListOutput.exitCode !== 0) {
      core.error(
        `lxc list command failed with return code: ${lxcListOutput.exitCode}`
      )
      core.setFailed(lxcListOutput.stderr)
      return
    }
    const lxcVmStatus = yaml.load(lxcListOutput.stdout) as [any]
    const openstackVmStatus = lxcVmStatus.find(
      vmStatus => vmStatus['name'] === OPENSTACK_VM_NAME
    )
    if (!openstackVmStatus) {
      core.error(`Failed to find OpenStack LXD VM in: ${lxcVmStatus}`)
      core.setFailed('Failed to find OpenStack LXD VM.')
      return
    }
    const lxcNetworks: { [key: string]: any } =
      openstackVmStatus['state']['network']
    // find eth network interface
    const ethInterfaceName = Object.keys(lxcNetworks).find(interfaceName =>
      interfaceName.startsWith('enp')
    )
    if (!ethInterfaceName) {
      core.error(
        `Unable to find eth interface in LXC VM networks ${lxcNetworks}`
      )
      core.setFailed('Unable to find eth interface in LXC VM networks.')
      return
    }
    const lxcEthInterface = lxcNetworks[ethInterfaceName]
    const lxcVMAddresses: [any] = lxcEthInterface['addresses']
    const ipv4Address = lxcVMAddresses.find(
      addressInfo => addressInfo['netmask'] === '24'
    )
    if (!ipv4Address) {
      core.error(`Unable to find ipv4 address ${lxcVMAddresses}`)
      core.setFailed('Unable to find ipv4 address.')
      return
    }
    const gatewayIP = ipv4Address['address']
    // TODO: fetch sunbeam IP from cloud-config.yaml
    // $ sudo k8s get load-balancer.cidrs
    // [172.16.1.201-172.16.1.240]
    const sumbeamIP = '172.16.1.192/26'
    await exec.exec(`sudo ip route add ${sumbeamIP} via ${gatewayIP}`)

    // test with openstack cli
    await exec.exec('sudo apt install python3-pip')
    await exec.exec('pip3 install python-openstackclient')
    await exec.exec('whoami')
    await exec.exec('echo $HOME')
    // testing steps
    // create flavor
    // creage image
    // create network
    // create subnet
    // create security group
    // create ssh key
    // create instance and test
    await exec.exec(
      `openstack --os-cloud ${SUNBEAM_ADMIN_CLOUD_NAME} server list`
    )
    await exec.exec(
      `openstack flavor create --public cpu2-ram8-disk20 --id auto --ram 8 --disk 20 --vcpus 2`
    )
    await exec.exec(`wget ${NOBLE_CLOUD_IMAGE}`)
    await exec.exec(
      `openstack image create --disk-format qcow2 --public --file=./noble-server-cloudimg-amd64.img --os-cloud=sunbeam-admin noble`
    )
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
